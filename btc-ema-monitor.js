'use strict';
const fs = require('node:fs');
const webpush = require('web-push');
const PERIOD = 300;
const STATE = 'btc-ema-state.json';
const MODE = (process.env.SIGNAL_MODE || 'both').toLowerCase();
if (!['ema','wma','either','both'].includes(MODE)) throw Error('Invalid SIGNAL_MODE');
const FILTER = process.env.VOLUME_FILTER !== 'false';
const VWAP_FILTER = process.env.VWAP_FILTER !== 'false';
const TREND_FILTER = process.env.TREND_FILTER !== 'false';
const API = 'https://api.india.delta.exchange/v2/history/candles';
function ema(rows, n) {
  let v = rows.slice(0,n).reduce((s,r)=>s+r.close,0)/n;
  const out = Array(n-1).fill(null).concat(v);
  for(let i=n;i<rows.length;i++) { v += (rows[i].close-v)*2/(n+1); out.push(v); }
  return out;
}
async function telegram(text){
  const token=process.env.TELEGRAM_BOT_TOKEN, chat=process.env.TELEGRAM_CHAT_ID;
  if(!token||!chat) throw Error('Telegram secrets missing');
  for(let attempt=0;attempt<2;attempt++){
    const res=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chat,text}),signal:AbortSignal.timeout(15000)});
    const data=await res.json().catch(()=>({}));
    if(res.ok&&data.ok===true)return;
    const wait=Number(data.parameters?.retry_after||res.headers.get('retry-after'));
    if(res.status===429&&attempt===0&&wait>0&&wait<=20){await new Promise(r=>setTimeout(r,(wait+1)*1000));continue;}
    throw Error('Telegram HTTP '+res.status);
  }
}
async function main(){
  const end = Math.floor(Date.now()/1000);
  const url = new URL(API);
  url.search = new URLSearchParams({symbol:'BTCUSD',resolution:'5m',start:String(end-950*PERIOD),end:String(end)});
  const res = await fetch(url,{signal:AbortSignal.timeout(20000)});
  if(!res.ok) throw Error('Delta HTTP '+res.status);
  const data = await res.json();
  if(!data.success || !Array.isArray(data.result)) throw Error('Invalid candle response');
  const rows = [...new Map(data.result.map(r=>[Number(r.time),{time:Number(r.time),close:Number(r.close),high:Number(r.high),low:Number(r.low),volume:Number(r.volume)}])).values()].filter(r=>Number.isFinite(r.time)&&Number.isFinite(r.close)&&r.close>0&&r.time+PERIOD<=end-5).sort((a,b)=>a.time-b.time);
  if(rows.length<600) throw Error('Insufficient EMA warmup candles');
  for(let i=1;i<rows.length;i++) if(rows[i].time-rows[i-1].time!==PERIOD) throw Error('Candle gap detected');
  const expected = Math.floor((end-5)/PERIOD)*PERIOD-PERIOD;
  if(rows.at(-1).time!==expected) throw Error('Latest closed candle unavailable');
  const e = Object.fromEntries([9,21,50,200].map(n=>[n,ema(rows,n)]));
  const wma = n => rows.map((r,i)=>i<n-1?null:rows.slice(i-n+1,i+1).reduce((sum,x,j)=>sum+x.close*(j+1),0)/(n*(n+1)/2));
  const w12=wma(12), w144=wma(144);
  let day=null, pv=0, vol=0, valid=true;
  const vwap=rows.map(r=>{
    const d=Math.floor(r.time/86400);
    if(d!==day){day=d;pv=0;vol=0;valid=r.time%86400===0;}
    if(!Number.isFinite(r.high)||!Number.isFinite(r.low)||!Number.isFinite(r.volume)||r.volume<0) valid=false;
    pv+=(r.high+r.low+r.close)/3*r.volume;vol+=r.volume;
    return valid&&vol>0?pv/vol:null;
  });
  const strong = i=>rows[i].close>e[9][i]&&e[9][i]>e[21][i]&&e[21][i]>e[50][i]&&e[50][i]>e[200][i]?1:rows[i].close<e[9][i]&&e[9][i]<e[21][i]&&e[21][i]<e[50][i]&&e[50][i]<e[200][i]?-1:0;
  const superTrend=i=>vwap[i]===null?0:strong(i)===1&&w12[i]>w144[i]&&rows[i].close>vwap[i]?1:strong(i)===-1&&w12[i]<w144[i]&&rows[i].close<vwap[i]?-1:0;
  const volumesOK = i => {
    const vs=rows.slice(i-20,i).map(x=>x.volume);
    return vs.length===20 && vs.every(v=>Number.isFinite(v)&&v>=0) && Number.isFinite(rows[i].volume) && rows[i].volume>vs.reduce((a,b)=>a+b,0)/20;
  };
  const direction = i => {
    const a=Math.sign(e[9][i]-e[21][i]), b=Math.sign(w12[i]-w144[i]);
    let d=MODE==='ema'?a:MODE==='wma'?b:MODE==='both'?(a===b?a:0):(a&&b&&a!==b?0:a||b);
    if(VWAP_FILTER && (!Number.isFinite(vwap[i]) || Math.sign(rows[i].close-vwap[i])!==d)) return 0;
    if(TREND_FILTER && Math.sign(e[50][i]-e[200][i])!==d) return 0;
    if(FILTER && !volumesOK(i)) return 0;
    return d;
  };
  let state={lastTime:0};
  if(fs.existsSync(STATE)) state=JSON.parse(fs.readFileSync(STATE,'utf8'));
  const first=state.lastTime?rows.findIndex(r=>r.time>state.lastTime):rows.length-1;
  if(first<0){console.log('Already processed');return;}
  if(first<201) throw Error('Saved state older than available warmup; review state before reset');
  for(let i=first;i<rows.length;i++) {
  const r=rows[i], signals=[];
  const seriesCross=(a,b)=>[a[i-1],b[i-1],a[i],b[i]].every(Number.isFinite)?(a[i-1]<=b[i-1]&&a[i]>b[i]?1:a[i-1]>=b[i-1]&&a[i]<b[i]?-1:0):0;
  const addCross=(a,b,up,down)=>{const c=seriesCross(a,b);if(c)signals.push(c===1?up:down);};
  addCross(e[9],e[21],'BUY — EMA 9/21','SELL — EMA 9/21');
  addCross(e[50],e[200],'GOLDEN CROSS','DEATH CROSS');
  addCross(w12,w144,'WMA BUY 12/144','WMA SELL 12/144');
  if(Math.floor(r.time/86400)===Math.floor(rows[i-1].time/86400)){
    addCross(rows.map(x=>x.close),vwap,'VWAP BUY','VWAP SELL');
    addCross(w12,vwap,'WMA VWAP POSITIVE','WMA VWAP NEGATIVE');
  }
  const trend=strong(i), st=superTrend(i), d=direction(i);
  if(trend&&trend!==strong(i-1))signals.push(trend===1?'STRONG POSITIVE':'STRONG NEGATIVE');
  if(st&&st!==superTrend(i-1))signals.push(st===1?'SUPER STRONG POSITIVE':'SUPER STRONG NEGATIVE');
  if(d&&d!==direction(i-1))signals.push('CONFIRMED '+(d===1?'BUY':'SELL')+' ('+MODE.toUpperCase()+')');
  const volumeOK=volumesOK(i);
  console.log(JSON.stringify({closeTime:new Date((r.time+PERIOD)*1000).toISOString(),price:r.close,ema9:e[9][i],ema21:e[21][i],ema50:e[50][i],ema200:e[200][i],wma12:w12[i],wma144:w144[i],vwap:vwap[i],volumeOK,signals}));
  if(signals.length){
    const body=['BTCUSD | 5m | $'+r.close.toFixed(2),...([9,21,50,200].map(n=>'EMA '+n+': '+e[n][i].toFixed(2))), 'WMA 12: '+w12[i].toFixed(2), 'WMA 144: '+w144[i].toFixed(2), 'VWAP: '+(vwap[i]===null?'Unavailable':vwap[i].toFixed(2)), 'Volume: '+(volumeOK?'Above MA20':'Not confirmed'), 'Close: '+new Date((r.time+PERIOD)*1000).toISOString()].join('\n');
    const title='BTC EMA PRO | '+signals.join(' | ');
    const results=await Promise.allSettled([
      (async()=>{webpush.setVapidDetails('https://asstrades-ship-it.github.io/btc-ema-pro/',process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY);await webpush.sendNotification(JSON.parse(process.env.WEB_PUSH_SUBSCRIPTION),JSON.stringify({title,body}),{TTL:300,timeout:15000});})(),
      telegram(title+'\n'+body)
    ]);
    results.forEach((result,j)=>{const channel=['Mobile Push','Telegram'][j];if(result.status==='fulfilled')console.log(channel+' accepted');else {console.error(channel+' failed',result.reason?.statusCode|| (j===1&&/^Telegram HTTP \d+$/.test(result.reason?.message)?result.reason.message:'delivery error'));process.exitCode=1;}});
  } else console.log('No eligible new signal');
  fs.writeFileSync(STATE+'.tmp',JSON.stringify({lastTime:r.time}));
  fs.renameSync(STATE+'.tmp',STATE);
  }
}
main().catch(e=>{console.error('Monitor failed:',e.statusCode||e.name, e.statusCode?'':e.message);process.exitCode=1;});
