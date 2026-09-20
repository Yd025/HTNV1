import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Scene, { type CameraMode, type Models } from './Scene';
import Radar from './Radar';
import { GAME_RULES, createGame, formatTime, startGame, togglePause, type GameState, type InputState, type WorldData } from '../lib/game';

function Icon({name,...props}:{name:'boat'|'arrow'|'pause'|'play'|'retry'|'close'|'pin'|'expand'|'camera'|'look';className?:string}) {
  const paths: Record<string,ReactNode>={
    boat:<><path d="m3 14 9 4 9-4-3 7H6l-3-7Z"/><path d="M8 16V8h8v8M12 3v5m-7 3h14"/></>,
    arrow:<><path d="M4 12h15m-6-6 6 6-6 6"/></>,pause:<><path d="M8 5v14M16 5v14"/></>,play:<path d="m8 4 12 8-12 8V4Z"/>,retry:<><path d="M4 10a8 8 0 1 1 1 8M4 4v6h6"/></>,close:<path d="m6 6 12 12M6 18 18 6"/>,pin:<><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2"/></>,expand:<path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5"/>,
    camera:<><path d="M4 7h4l2-3h4l2 3h4v13H4Z"/><circle cx="12" cy="13" r="4"/></>,
    look:<><path d="M20 19v-7a6 6 0 0 0-6-6H4m5-4L4 6l5 4"/></>
  };
  return <svg {...props} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

class SceneBoundary extends Component<{children:ReactNode},{failed:boolean}> {
  state={failed:false}; static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?<div className="scene-error"><h2>The 3D view couldn’t start.</h2><p>Enable hardware acceleration in your browser, then reload the game.</p><button className="primary" onClick={()=>window.location.reload()}>Reload game</button></div>:this.props.children;}
}

const snapshot=(s:GameState):GameState=>({...s,boat:{...s.boat},drones:s.drones.map(drone=>({...drone})),plane:{...s.plane},towers:s.towers.map(t=>({...t})),lastKnown:s.lastKnown?{...s.lastKnown}:null});
// The expanded fleet has its own record; earlier single-drone runs stay intact.
const BEST_KEY='cant-catch-me-best-downriver-fleet-pace2';

export default function Game() {
  const [assets,setAssets]=useState<{world:WorldData;models:Models}|null>(null),[error,setError]=useState('');
  useEffect(()=>{
    const controller=new AbortController();
    Promise.all(['/assets/world.json','/assets/models.json'].map(async url=>{const r=await fetch(url,{signal:controller.signal});if(!r.ok)throw new Error('Asset download failed');return r.json();}))
      .then(([world,models])=>setAssets({world,models})).catch(e=>{if(e.name!=='AbortError')setError('The coastline couldn’t load. Check your connection and try again.');});
    return ()=>controller.abort();
  },[]);
  if(error)return <main className="loading-screen"><h1>Let’s try that again.</h1><p>{error}</p><button className="primary" onClick={()=>location.reload()}>Reload game</button></main>;
  if(!assets)return <main className="loading-screen"><span className="loading-mark"/><p>Charting the coastline…</p></main>;
  return <Session {...assets}/>;
}

function Session({world,models}:{world:WorldData;models:Models}) {
  const [initialGame]=useState(()=>createGame(world));
  const game=useRef(initialGame),input=useRef<InputState>({throttle:0,steer:0});
  const lookBack=useRef(false);
  const [cameraMode,setCameraMode]=useState<CameraMode>('helm'),[motionEnabled,setMotionEnabled]=useState(true);
  const [hud,setHud]=useState(()=>snapshot(game.current)),[best,setBest]=useState(0),[sceneReady,setSceneReady]=useState(false),[reducedMotion,setReducedMotion]=useState(false),[controls,setControls]=useState(false);
  const keys=useRef(new Set<string>()),touch=useRef(new Set<string>()),newBest=useRef(false),main=useRef<HTMLElement>(null),action=useRef<HTMLButtonElement>(null);
  const reported=useRef('ready');
  const update=useCallback(()=>{
    const s=game.current;setHud(snapshot(s));
    if(s.status==='caught'&&reported.current!=='caught'){
      setBest(previous=>{newBest.current=s.time>previous;const next=Math.max(previous,s.time);try{localStorage.setItem(BEST_KEY,String(next));}catch{}return next;});
    }
    reported.current=s.status;
  },[]);
  const ready=useCallback(()=>setSceneReady(true),[]);
  const clearInput=useCallback(()=>{keys.current.clear();touch.current.clear();lookBack.current=false;input.current={throttle:0,steer:0};},[]);
  const changeCamera=useCallback(()=>{setCameraMode(previous=>previous==='helm'?'chase':'helm');if(game.current.status==='playing')main.current?.focus();},[]);
  const changeMotion=()=>setMotionEnabled(previous=>{try{localStorage.setItem('cant-catch-me-camera-motion',String(!previous));}catch{}return !previous;});
  const refreshInput=useCallback(()=>{
    const pressed=(...codes:string[])=>codes.some(c=>keys.current.has(c)||touch.current.has(c));
    input.current={throttle:pressed('KeyS','ArrowDown')?-1:Number(pressed('KeyW','ArrowUp')),steer:Number(pressed('KeyD','ArrowRight'))-Number(pressed('KeyA','ArrowLeft'))};
  },[]);
  const begin=useCallback(()=>{clearInput();newBest.current=false;startGame(game.current);setControls(false);update();main.current?.focus();},[clearInput,update]);
  const pause=useCallback(()=>{clearInput();togglePause(game.current);update();},[clearInput,update]);
  useEffect(()=>{
    try{const saved=Number(localStorage.getItem(BEST_KEY));if(Number.isFinite(saved)&&saved>0)setBest(saved);setMotionEnabled(localStorage.getItem('cant-catch-me-camera-motion')!=='false');}catch{}
    const mq=window.matchMedia('(prefers-reduced-motion: reduce)');setReducedMotion(mq.matches);const motion=()=>setReducedMotion(mq.matches);mq.addEventListener('change',motion);
    return ()=>mq.removeEventListener('change',motion);
  },[]);
  useEffect(()=>{
    const down=(e:KeyboardEvent)=>{
      const status=game.current.status;
      if(e.code==='Escape'||e.code==='KeyP'){if(!e.repeat){e.preventDefault();pause();}return;}
      if((e.code==='Space'||e.code==='Enter')&&(status==='ready'||status==='caught')&&sceneReady){if(!(e.target instanceof HTMLButtonElement)){e.preventDefault();begin();}return;}
      if(e.target instanceof HTMLButtonElement&&(e.code==='Space'||e.code==='Enter'))return;
      if(status!=='playing')return;
      if(e.code==='KeyC'){if(!e.repeat){e.preventDefault();changeCamera();}return;}
      if(e.code==='Space'){e.preventDefault();lookBack.current=true;return;}
      if(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowLeft','ArrowDown','ArrowRight','Space'].includes(e.code)){e.preventDefault();keys.current.add(e.code);refreshInput();}
    };
    const up=(e:KeyboardEvent)=>{keys.current.delete(e.code);if(e.code==='Space')lookBack.current=false;refreshInput();};
    const blur=()=>{clearInput();if(game.current.status==='playing'){togglePause(game.current);update();}};
    const visibility=()=>{if(document.hidden)blur();};
    window.addEventListener('keydown',down);window.addEventListener('keyup',up);window.addEventListener('blur',blur);document.addEventListener('visibilitychange',visibility);
    return ()=>{window.removeEventListener('keydown',down);window.removeEventListener('keyup',up);window.removeEventListener('blur',blur);document.removeEventListener('visibilitychange',visibility);};
  },[begin,pause,refreshInput,clearInput,sceneReady,update,changeCamera]);
  useEffect(()=>{if(hud.status==='paused'||hud.status==='caught')action.current?.focus();},[hud.status]);
  const touchButton=(code:string,label:string,className:string)=><button className={`touch-button ${className}`} aria-label={label} onContextMenu={e=>e.preventDefault()} onPointerDown={e=>{e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);touch.current.add(code);refreshInput();}} onPointerUp={()=>{touch.current.delete(code);refreshInput();}} onPointerCancel={()=>{touch.current.delete(code);refreshInput();}} onLostPointerCapture={()=>{touch.current.delete(code);refreshInput();}}><Icon name="arrow"/></button>;
  const isIntro=hud.status==='ready';
  const nearestDrone=hud.drones.reduce((nearest,drone)=>drone.distanceToBoat<nearest.distanceToBoat?drone:nearest);
  const lockingDrone=hud.drones.reduce((closest,drone)=>drone.tagProgress>closest.tagProgress?drone:closest);
  const statusText=hud.alert==='tagging'?`${lockingDrone.id} locking on`:hud.alert==='detected'?(hud.plane.detecting?'Scout sharing your position':'You’ve been spotted'):hud.alert==='searching'?'They lost your trail':'Out of sight';
  const relativeDrone=Math.atan2(nearestDrone.x-hud.boat.x,nearestDrone.z-hud.boat.z)-hud.boat.heading;
  const droneBearing=Math.atan2(Math.sin(relativeDrone),Math.cos(relativeDrone));
  const droneDirection=Math.abs(droneBearing)<Math.PI/4?'ahead':Math.abs(droneBearing)>Math.PI*3/4?'astern':droneBearing>0?'to port':'to starboard';
  return <main ref={main} tabIndex={-1} className={`game-shell ${cameraMode==='helm'?'helm-view':''} ${isIntro?'is-intro':''} ${hud.status==='caught'?'is-caught':''}`} aria-label="Can't Catch Me boat survival game">
    <div className="scene"><SceneBoundary><Scene world={world} models={models} game={game} input={input} onUpdate={update} onReady={ready} reducedMotion={reducedMotion||!motionEnabled} cameraMode={cameraMode} lookBack={lookBack}/></SceneBoundary></div>
    <div className="vignette"/>
    <header className="topbar">
      <div className="brand"><span className="brand-icon"><Icon name="boat"/></span><span>can’t catch me<span className="brand-period">.</span></span></div>
      <div className="top-actions"><span className="location"><Icon name="pin"/>Fort Ross, Nunavut</span>{!isIntro&&<>
        <button className="icon-button camera-button" aria-label={`Switch to ${cameraMode==='helm'?'chase':'helm'} camera`} title="Change camera (C)" onClick={changeCamera}><Icon name="camera"/><span>{cameraMode==='helm'?'Helm':'Chase'}</span></button>
        <button className="icon-button look-button" aria-label={lookBack.current?'Look forward':'Look back'} aria-pressed={lookBack.current} title="Look behind you (or hold Space)" disabled={hud.status!=='playing'} onClick={()=>{lookBack.current=!lookBack.current;main.current?.focus();}}><Icon name="look"/></button>
        <button className="icon-button" aria-label={hud.status==='paused'?'Resume game':'Pause game'} onClick={pause} disabled={hud.status==='caught'}><Icon name={hud.status==='paused'?'play':'pause'}/></button>
      </>}<button className="icon-button fullscreen" aria-label="Toggle fullscreen" onClick={()=>{if(document.fullscreenElement)void document.exitFullscreen().catch(()=>{});else void main.current?.requestFullscreen?.().catch(()=>{});}}><Icon name="expand"/></button></div>
    </header>

    {isIntro ? <>
      <section className="intro">
        <h1>can’t<br/>catch me<span>.</span></h1>
        <p className="intro-copy">Two towers. Two drones. One scout plane.<br/>Keep heading downriver. How long can you stay free?</p>
        <button className="primary start" disabled={!sceneReady} onClick={begin}>{sceneReady?'Make your escape':'Preparing the water…'}<Icon name="arrow"/></button>
        <div className="intro-meta"><span>{GAME_RULES.pace}× pace</span><span className="meta-dot"/><span>Survive as long as you can</span>{best>0&&<><span className="meta-dot"/><span>Best {formatTime(best)}</span></>}</div>
      </section>
      <aside className="field-note"><span className="note-line"/><p>They share every sighting.<br/>Break their view.<br/><strong>Buy another second.</strong></p></aside>
      <footer className="intro-footer"><div className="keyboard-hint"><span className="key-group"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span><span>or arrow keys to steer</span></div><span className="world-caption">The waters of Fort Ross · 71.99° N</span></footer>
    </> : <>
      <section className="score" aria-label="Survival time"><span>Still free</span><strong>{formatTime(hud.time)}</strong>{best>0&&<small>Best {formatTime(best)}</small>}</section>
      <div className={`contact-status ${hud.alert}`} role="status" aria-live="polite"><span className="status-light"/><span>{statusText}</span></div>
      {hud.tagProgress>0&&<div className="tag-warning"><span>Break {lockingDrone.id}’s lock</span><div className="tag-track"><i style={{width:`${hud.tagProgress*100}%`}}/></div><small>{Math.max(0,GAME_RULES.tagSeconds-hud.tagProgress*GAME_RULES.tagSeconds).toFixed(1)}s until tagged</small></div>}
      {hud.collision&&<div className="collision-warning" role="status">Shallow water — brake and steer toward the channel</div>}
      <div className="instruments"><div className="speed"><strong>{Math.round(Math.abs(hud.boat.speed)*1.94384)}</strong><span>knots</span></div><div className="speed-track"><i style={{height:`${Math.abs(hud.boat.speed)/GAME_RULES.maxSpeed*100}%`}}/></div><div className="drone-distance" aria-label={`Nearest drone ${nearestDrone.id}, ${droneDirection}, ${Math.round(nearestDrone.distanceToBoat)} metres`}><span>{nearestDrone.id} {droneDirection}</span><strong>{nearestDrone.distanceToBoat>=1000?`${(nearestDrone.distanceToBoat/1000).toFixed(1)} km`:`${Math.round(nearestDrone.distanceToBoat)} m`}</strong><small>Nearest drone</small></div></div>
      <div className="radar-position"><Radar world={world} state={hud}/></div>
      <div className="desktop-controls"><span><kbd>W</kbd> accelerate</span><span><kbd>S</kbd> brake</span><span><kbd>A</kbd><kbd>D</kbd> turn</span><span><kbd>Space</kbd> look back</span><span><kbd>C</kbd> view</span><span><kbd>Esc</kbd> pause</span></div>
      {hud.status==='playing'&&<div className="touch-controls"><div>{touchButton('KeyA','Steer left','left')}{touchButton('KeyD','Steer right','right')}</div><div>{touchButton('KeyS','Brake','down')}{touchButton('KeyW','Accelerate','up')}</div></div>}
    </>}

    {(hud.status==='paused'||hud.status==='caught')&&<div className="menu-scrim"><section className="run-menu" role="dialog" aria-modal="true" aria-labelledby="menu-title" onKeyDown={e=>{
      if(e.key!=='Tab')return;
      const buttons=Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const first=buttons[0],last=buttons[buttons.length-1];
      if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
      else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
    }}>
      {hud.status==='paused'?<><span className="menu-symbol"><Icon name="pause"/></span><h2 id="menu-title">Catch your breath.</h2><p>The chase is paused. The coast can wait.</p><button ref={action} className="primary" onClick={pause}>Back to the water<Icon name="play"/></button></>:<><span className="menu-symbol caught-symbol"><Icon name="boat"/></span><h2 id="menu-title">Caught. This time.</h2><p>You kept them chasing for</p><div className="final-time">{formatTime(hud.time)}</div><span className="best-result">{newBest.current?'A new personal best.':`Your best: ${formatTime(best)}`}</span><button ref={action} className="primary" onClick={begin}>One more escape<Icon name="retry"/></button></>}
      <div className="view-options"><button onClick={changeCamera}>View: {cameraMode==='helm'?'Helm':'Chase'}</button><button onClick={changeMotion} aria-pressed={motionEnabled&&!reducedMotion} disabled={reducedMotion}>Camera sway: {motionEnabled&&!reducedMotion?'on':'off'}</button></div>
      <button className="text-button" onClick={()=>setControls(!controls)} aria-expanded={controls}>{controls?'Hide controls':'How to play'}</button>
      {controls&&<div className="how-to"><p><strong>W / ↑</strong> accelerate. <strong>S / ↓</strong> brake. <strong>A D / ← →</strong> steer.</p><p>Keep heading downriver. You can slow down and steer across the channel, but cannot reverse or make a U-turn.</p><p><strong>Hold Space</strong> to look back. <strong>C</strong> changes view. Escape pauses the game. Camera sway can be turned off above.</p><p>Two towers, two drones and a scout plane share sightings. The plane searches ahead and directs the drones; it cannot tag you.</p><p>The drones are faster than your boat. Use the coast and islands to break their view and buy time. Either drone staying within {GAME_RULES.tagRadius} metres with a clear view for {GAME_RULES.tagSeconds} continuous seconds ends your run. Each drone has its own lock.</p><p>Survival time is your score. The chase runs at {GAME_RULES.pace}× pace; your score and the two-second tag count real seconds.</p></div>}
    </section></div>}
  </main>;
}
