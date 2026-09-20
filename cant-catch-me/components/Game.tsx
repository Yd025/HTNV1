import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Scene, { type CameraMode, type Models } from './Scene';
import Radar from './Radar';
import LoadingScreen from './LoadingScreen';
import { GAME_RULES, createGame, formatTime, startGame, togglePause, type GameState, type InputState, type WorldData } from '../lib/game';

function Icon({name,...props}:{name:'boat'|'arrow'|'pause'|'play'|'retry'|'close'|'pin'|'expand'|'camera'|'look'|'boost';className?:string}) {
  const paths: Record<string,ReactNode>={
    boat:<><path d="m3 14 9 4 9-4-3 7H6l-3-7Z"/><path d="M8 16V8h8v8M12 3v5m-7 3h14"/></>,
    arrow:<><path d="M4 12h15m-6-6 6 6-6 6"/></>,pause:<><path d="M8 5v14M16 5v14"/></>,play:<path d="m8 4 12 8-12 8V4Z"/>,retry:<><path d="M4 10a8 8 0 1 1 1 8M4 4v6h6"/></>,close:<path d="m6 6 12 12M6 18 18 6"/>,pin:<><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2"/></>,expand:<path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5"/>,
    camera:<><path d="M4 7h4l2-3h4l2 3h4v13H4Z"/><circle cx="12" cy="13" r="4"/></>,
    look:<><path d="M20 19v-7a6 6 0 0 0-6-6H4m5-4L4 6l5 4"/></>,
    boost:<><path d="m5 14 7-7 7 7m-14 5 7-7 7 7"/></>
  };
  return <svg {...props} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

class SceneBoundary extends Component<{children:ReactNode},{failed:boolean}> {
  state={failed:false}; static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?<div className="scene-error"><h2>The 3D view couldn’t start.</h2><p>Enable hardware acceleration in your browser, then reload the game.</p><button className="primary" onClick={()=>window.location.reload()}>Reload game</button></div>:this.props.children;}
}

const snapshot=(s:GameState):GameState=>({...s,boat:{...s.boat},drones:s.drones.map(drone=>({...drone})),plane:{...s.plane},towers:s.towers.map(t=>({...t})),pickups:s.pickups.map(pickup=>({...pickup})),lastKnown:s.lastKnown?{...s.lastKnown}:null});
// Endless routes and boosts have their own record; previous scores stay intact.
const BEST_KEY='cant-catch-me-best-endless-boost-pace2';
const formatDistance=(metres:number)=>metres>=1000?`${(metres/1000).toFixed(1)} km`:`${Math.round(metres)} m`;

function HowToPlay() {
  return <div className="how-to" id="play-guide">
    <dl className="control-list">
      <div><dt><kbd>W</kbd><span>/</span><kbd>↑</kbd></dt><dd>Accelerate</dd></div>
      <div><dt><kbd>S</kbd><span>/</span><kbd>↓</kbd></dt><dd>Brake</dd></div>
      <div><dt><kbd>A</kbd><kbd>D</kbd><span>/</span><kbd>←</kbd><kbd>→</kbd></dt><dd>Steer</dd></div>
      <div><dt><kbd>Space</kbd></dt><dd>Hold to look back</dd></div>
      <div><dt><kbd>C</kbd></dt><dd>Change camera</dd></div>
      <div><dt><kbd>Esc</kbd></dt><dd>Pause</dd></div>
    </dl>
    <p className="touch-guide">On touch screens, use the arrows along the bottom.</p>
    <div className="play-rules">
      <div><h3>Keep moving downriver</h3><p>Slow down and steer across the channel. No reversing or U-turns.</p></div>
      <div><h3>Break their view</h3><p>The towers and scout share your position; only drones can tag you. A drone within {GAME_RULES.tagRadius} m needs a clear view for {GAME_RULES.tagSeconds} uninterrupted seconds. Hide behind the coast to break its lock.</p></div>
      <div className="boost-rule"><h3><Icon name="boost"/>Catch a speed boost</h3><p>Collect orange boosts for {GAME_RULES.boostDuration} seconds of extra speed. They appear in different places each run.</p></div>
      <div><h3>Leave the patrol behind</h3><p>Cross beyond the first stretch to lose the drones. The towers stay there; new coast keeps unfolding ahead.</p></div>
    </div>
    <p className="rules-note">Your time is your score. The chase runs at {GAME_RULES.pace}× pace; timers count real seconds. Camera sway is optional in the pause menu.</p>
  </div>;
}

export default function Game() {
  const [assets,setAssets]=useState<{world:WorldData;models:Models}|null>(null),[error,setError]=useState(''),[assetsLoaded,setAssetsLoaded]=useState(0),[loadAttempt,setLoadAttempt]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    Promise.all(['/assets/world.json','/assets/models.json'].map(async url=>{const r=await fetch(url,{signal:controller.signal});if(!r.ok)throw new Error('Asset download failed');const asset=await r.json();if(!controller.signal.aborted)setAssetsLoaded(previous=>previous+1);return asset;}))
      .then(([world,models])=>setAssets({world,models})).catch(e=>{if(e.name!=='AbortError')setError('The coastline couldn’t load. Check your connection and try again.');});
    return ()=>controller.abort();
  },[loadAttempt]);
  if(error)return <LoadingScreen stage="assets" error={error} onRetry={()=>{setError('');setAssetsLoaded(0);setLoadAttempt(previous=>previous+1);}}/>;
  if(!assets)return <LoadingScreen stage="assets" assetsLoaded={assetsLoaded}/>;
  return <SceneBoundary><Session {...assets}/></SceneBoundary>;
}

function Session({world,models}:{world:WorldData;models:Models}) {
  const [initialGame]=useState(()=>createGame(world,Math.floor(Math.random()*0x100000000)));
  const game=useRef(initialGame),input=useRef<InputState>({throttle:0,steer:0});
  const lookBack=useRef(false);
  const [cameraMode,setCameraMode]=useState<CameraMode>('helm'),[motionEnabled,setMotionEnabled]=useState(true);
  const [hud,setHud]=useState(()=>snapshot(game.current)),[best,setBest]=useState(0),[sceneReady,setSceneReady]=useState(false),[reducedMotion,setReducedMotion]=useState(false),[controls,setControls]=useState(false);
  const keys=useRef(new Set<string>()),touch=useRef(new Set<string>()),newBest=useRef(false),main=useRef<HTMLElement>(null),action=useRef<HTMLButtonElement>(null),guideButton=useRef<HTMLButtonElement>(null),guideClose=useRef<HTMLButtonElement>(null);
  const [escapeNotice,setEscapeNotice]=useState(false);
  const reported=useRef('ready'),bestRecord=useRef(0),bestAtRunStart=useRef(0);
  const saveBest=useCallback((updateDisplay=true)=>{
    const score=game.current.time;
    if(!Number.isFinite(score)||score<=bestRecord.current)return;
    let next=score;
    try{
      const stored=Number(localStorage.getItem(BEST_KEY));
      if(Number.isFinite(stored))next=Math.max(next,stored);
      localStorage.setItem(BEST_KEY,String(next));
    }catch{}
    bestRecord.current=next;
    if(updateDisplay)setBest(next);
  },[]);
  const update=useCallback(()=>{
    const s=game.current;setHud(snapshot(s));
    if(s.status!==reported.current){
      if(s.status==='caught')newBest.current=s.time>bestAtRunStart.current;
      if(s.status==='caught'||s.status==='paused')saveBest();
    }
    reported.current=s.status;
  },[saveBest]);
  const ready=useCallback(()=>setSceneReady(true),[]);
  const clearInput=useCallback(()=>{keys.current.clear();touch.current.clear();lookBack.current=false;input.current={throttle:0,steer:0};},[]);
  const changeCamera=useCallback(()=>{setCameraMode(previous=>previous==='helm'?'chase':'helm');if(game.current.status==='playing')main.current?.focus();},[]);
  const changeMotion=()=>setMotionEnabled(previous=>{try{localStorage.setItem('cant-catch-me-camera-motion',String(!previous));}catch{}return !previous;});
  const refreshInput=useCallback(()=>{
    const pressed=(...codes:string[])=>codes.some(c=>keys.current.has(c)||touch.current.has(c));
    input.current={throttle:pressed('KeyS','ArrowDown')?-1:Number(pressed('KeyW','ArrowUp')),steer:Number(pressed('KeyD','ArrowRight'))-Number(pressed('KeyA','ArrowLeft'))};
  },[]);
  const begin=useCallback(()=>{clearInput();newBest.current=false;bestAtRunStart.current=bestRecord.current;if(game.current.status==='caught')game.current=createGame(world,Math.floor(Math.random()*0x100000000));startGame(game.current);setControls(false);update();main.current?.focus();},[clearInput,update,world]);
  const pause=useCallback(()=>{clearInput();togglePause(game.current);update();},[clearInput,update]);
  useEffect(()=>{
    try{const saved=Number(localStorage.getItem(BEST_KEY));if(Number.isFinite(saved)&&saved>0){bestRecord.current=saved;setBest(saved);}setMotionEnabled(localStorage.getItem('cant-catch-me-camera-motion')!=='false');}catch{}
    const mq=window.matchMedia('(prefers-reduced-motion: reduce)');setReducedMotion(mq.matches);const motion=()=>setReducedMotion(mq.matches);mq.addEventListener('change',motion);
    return ()=>mq.removeEventListener('change',motion);
  },[]);
  useEffect(()=>{
    // Escaped runs have no capture screen: keep their record while they continue.
    const interval=window.setInterval(()=>{if(game.current.status==='playing')saveBest();},5000);
    const leaving=()=>saveBest(false);
    window.addEventListener('pagehide',leaving);
    return ()=>{window.clearInterval(interval);window.removeEventListener('pagehide',leaving);leaving();};
  },[saveBest]);
  useEffect(()=>{
    const down=(e:KeyboardEvent)=>{
      const status=game.current.status;
      if(e.code==='Escape'||e.code==='KeyP'){if(!e.repeat){e.preventDefault();if(status==='ready'&&controls){setControls(false);guideButton.current?.focus();}else pause();}return;}
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
  },[begin,pause,refreshInput,clearInput,sceneReady,update,changeCamera,controls]);
  useEffect(()=>{if(hud.status==='paused'||hud.status==='caught')action.current?.focus();},[hud.status]);
  useEffect(()=>{if(controls&&hud.status==='ready')guideClose.current?.focus();},[controls,hud.status]);
  useEffect(()=>{
    if(!hud.escaped){setEscapeNotice(false);return;}
    setEscapeNotice(true);
    const timer=window.setTimeout(()=>setEscapeNotice(false),6500);
    return ()=>window.clearTimeout(timer);
  },[hud.escaped]);
  const touchButton=(code:string,label:string,className:string)=><button className={`touch-button ${className}`} aria-label={label} onContextMenu={e=>e.preventDefault()} onPointerDown={e=>{e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);touch.current.add(code);refreshInput();}} onPointerUp={()=>{touch.current.delete(code);refreshInput();}} onPointerCancel={()=>{touch.current.delete(code);refreshInput();}} onLostPointerCapture={()=>{touch.current.delete(code);refreshInput();}}><Icon name="arrow"/></button>;
  const isIntro=hud.status==='ready';
  const nearestDrone=hud.drones.reduce((nearest,drone)=>drone.distanceToBoat<nearest.distanceToBoat?drone:nearest);
  const lockingDrone=hud.drones.reduce((closest,drone)=>drone.tagProgress>closest.tagProgress?drone:closest);
  const statusText=hud.escaped?'Patrol left behind':hud.alert==='tagging'?`${lockingDrone.id} locking on`:hud.alert==='detected'?(hud.plane.detecting?'Scout sharing your position':'You’ve been spotted'):hud.alert==='searching'?'They lost your trail':'Out of sight';
  const relativeDrone=Math.atan2(nearestDrone.x-hud.boat.x,nearestDrone.z-hud.boat.z)-hud.boat.heading;
  const droneBearing=Math.atan2(Math.sin(relativeDrone),Math.cos(relativeDrone));
  const droneDirection=Math.abs(droneBearing)<Math.PI/4?'ahead':Math.abs(droneBearing)>Math.PI*3/4?'astern':droneBearing>0?'to port':'to starboard';
  return <main ref={main} tabIndex={-1} className={`game-shell ${cameraMode==='helm'?'helm-view':''} ${isIntro?'is-intro':''} ${controls&&isIntro?'guide-open':''} ${hud.status==='caught'?'is-caught':''}`} aria-label="Can't Catch Me boat survival game">
    <div className="scene"><Scene world={world} models={models} game={game} input={input} onUpdate={update} onReady={ready} reducedMotion={reducedMotion||!motionEnabled} cameraMode={cameraMode} lookBack={lookBack}/></div>
    <div className="vignette"/>
    <header className="topbar">
      <div className="brand"><span className="brand-icon"><Icon name="boat"/></span><span>can’t catch me<span className="brand-period">.</span></span></div>
      <div className="top-actions"><span className="location"><Icon name="pin"/>Fort Ross, Nunavut</span>{!isIntro&&<>
        <button className="icon-button camera-button" aria-label={`Switch to ${cameraMode==='helm'?'chase':'helm'} camera`} title="Change camera (C)" onClick={changeCamera}><Icon name="camera"/><span>{cameraMode==='helm'?'Helm':'Chase'}</span></button>
        <button className="icon-button look-button" aria-label={lookBack.current?'Look forward':'Look back'} aria-pressed={lookBack.current} title="Look behind you (or hold Space)" disabled={hud.status!=='playing'} onClick={()=>{lookBack.current=!lookBack.current;main.current?.focus();}}><Icon name="look"/></button>
        <button className="icon-button" aria-label={hud.status==='paused'?'Resume game':'Pause game'} onClick={pause} disabled={hud.status==='caught'}><Icon name={hud.status==='paused'?'play':'pause'}/></button>
      </>}<button className="icon-button fullscreen" disabled={!sceneReady} aria-label="Toggle fullscreen" onClick={()=>{if(document.fullscreenElement)void document.exitFullscreen().catch(()=>{});else void main.current?.requestFullscreen?.().catch(()=>{});}}><Icon name="expand"/></button></div>
    </header>

    {isIntro ? <>
      <section className="intro">
        <h1>can’t<br/>catch me<span>.</span></h1>
        <p className="intro-copy">Two towers. Two drones. One endless escape.<br/>Catch a boost. Outrun the patrol. Find what’s beyond.</p>
        <button className="primary start" disabled={!sceneReady} onClick={begin}>{sceneReady?'Make your escape':'Preparing the water…'}<Icon name="arrow"/></button>
        <button ref={guideButton} className="text-button intro-help" disabled={!sceneReady} onClick={()=>setControls(previous=>!previous)} aria-expanded={controls} aria-controls="play-guide">{controls?'Hide guide':'How to play'}</button>
        <div className="intro-meta"><span>{GAME_RULES.pace}× pace</span><span className="meta-dot"/><span>Survive as long as you can</span>{best>0&&<><span className="meta-dot"/><span>Best {formatTime(best)}</span></>}</div>
      </section>
      {controls?<aside className="intro-guide" aria-labelledby="guide-title"><div className="guide-heading"><h2 id="guide-title">Make a clean escape.</h2><button ref={guideClose} className="icon-button" aria-label="Close how to play" onClick={()=>{setControls(false);guideButton.current?.focus();}}><Icon name="close"/></button></div><HowToPlay/></aside>:<aside className="field-note"><span className="note-line"/><p>The coast keeps going.<br/>Their patrol doesn’t.<br/><strong>Get beyond their reach.</strong></p></aside>}
      <footer className="intro-footer"><div className="keyboard-hint"><span className="key-group"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span><span>or arrow keys to steer</span></div><span className="world-caption">The waters of Fort Ross · 71.99° N</span></footer>
    </> : <>
      <section className="score" aria-label="Survival time"><span>Still free</span><strong>{formatTime(hud.time)}</strong>{best>0&&<small>Best {formatTime(best)}</small>}</section>
      <div className={`contact-status ${hud.escaped?'escaped':hud.alert}`} role="status" aria-live="polite"><span className="status-light"/><span>{statusText}</span></div>
      {escapeNotice&&<div className="escape-notice" role="status"><strong>You’re beyond their reach.</strong><span>Fresh coast ahead. Keep going.</span></div>}
      {hud.tagProgress>0&&<div className="tag-warning"><span>Break {lockingDrone.id}’s lock</span><div className="tag-track"><i style={{width:`${hud.tagProgress*100}%`}}/></div><small>{Math.max(0,GAME_RULES.tagSeconds-hud.tagProgress*GAME_RULES.tagSeconds).toFixed(1)}s until tagged</small></div>}
      {hud.collision&&<div className="collision-warning" role="status">Shallow water — brake and steer toward the channel</div>}
      <div className={`instruments ${hud.boostRemaining>0?'is-boosting':''}`}>
        <div className="speed"><strong>{Math.round(Math.abs(hud.boat.speed)*1.94384)}</strong><span>knots</span></div>
        <div className="speed-track"><i style={{height:`${Math.min(100,Math.abs(hud.boat.speed)/(GAME_RULES.maxSpeed*(hud.boostRemaining>0?GAME_RULES.boostMultiplier:1))*100)}%`}}/></div>
        <div className="drone-distance" aria-label={hud.escaped?'Patrol left behind':`Nearest drone ${nearestDrone.id}, ${droneDirection}, ${Math.round(nearestDrone.distanceToBoat)} metres`}><span>{hud.escaped?'Clear water':`${nearestDrone.id} ${droneDirection}`}</span><strong>{hud.escaped?'Keep exploring':formatDistance(nearestDrone.distanceToBoat)}</strong><small>{hud.escaped?'Patrol left behind':'Nearest drone'}</small></div>
        <div className={`boost-instrument ${hud.boostRemaining>0?'active':''}`}><Icon name="boost"/>{hud.boostRemaining>0?<><span>Boost<strong>{hud.boostRemaining.toFixed(1)}<small> s</small></strong></span><div className="boost-track"><i style={{width:`${hud.boostRemaining/GAME_RULES.boostDuration*100}%`}}/></div></>:<span>Collect orange boosts</span>}</div>
      </div>
      <div className="radar-position"><div className="route-progress"><span>{hud.sectorX===0&&hud.sectorZ===0?'Home waters':`Reach ${Math.max(Math.abs(hud.sectorX),Math.abs(hud.sectorZ))+1}`}</span><strong>{formatDistance(hud.distanceTraveled)}<span> traveled</span></strong></div><Radar world={world} state={hud}/></div>
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
      <button className="text-button" onClick={()=>setControls(!controls)} aria-expanded={controls} aria-controls="play-guide">{controls?'Hide guide':'How to play'}</button>
      {controls&&<HowToPlay/>}
    </section></div>}
    {!sceneReady&&<LoadingScreen stage="scene"/>}
  </main>;
}
