import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GAME_RULES, SIMULATION_STEP, getSector, sampleRiverHeight, stepGame, type GameState, type InputState, type WorldData } from '../lib/game';
import { Ocean, FoamWake, swellHeight, type BoatPose } from './Ocean';

type Part = { name: string; type: string; material: string; color?: string; positions?: number[]; indices?: number[]; matrix?: number[]; size?: number[]; radius?: number; length?: number };
export type Models = Record<string, { parts: Part[] }>;
export type CameraMode = 'helm' | 'chase';
type Props = { world: WorldData; models: Models; game: MutableRefObject<GameState>; input: MutableRefObject<InputState>; onUpdate: () => void; reducedMotion: boolean; onReady: () => void; cameraMode: CameraMode; lookBack: MutableRefObject<boolean> };
const palette: Record<string, string> = { body: '#244653', panel: '#edf4ee', metal: '#708e91', accent: '#f6a04d' };

function buildModel(model: Models[string], kind: string) {
  // Preserve handedness: source forward/port/up becomes Three +Z/+X/+Y.
  const transform = new THREE.Matrix4().set(0,1,0,0, 0,0,1,0, 1,0,0,0, 0,0,0,1);
  const groups = new Map<string, THREE.BufferGeometry[]>();
  model.parts.forEach(part => {
    let geometry: THREE.BufferGeometry;
    if (part.type === 'mesh') {
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(part.positions!, 3));
      if(kind==='boat'){
        // The source repeats 3,729 faces with reversed winding. DoubleSide already
        // draws their backs; drawing both copies causes coplanar surface flicker.
        const seen=new Set<string>(),indices:number[]=[];
        for(let i=0;i<part.indices!.length;i+=3){
          const triangle=part.indices!.slice(i,i+3),key=[...triangle].sort((a,b)=>a-b).join(',');
          if(!seen.has(key)){seen.add(key);indices.push(...triangle);}
        }
        geometry.setIndex(indices);
      }else geometry.setIndex(part.indices!);
    } else {
      if (part.type === 'box') geometry = new THREE.BoxGeometry(...part.size! as [number,number,number]);
      else if (part.type === 'cylinder') { geometry = new THREE.CylinderGeometry(part.radius, part.radius, part.length, 12); geometry.rotateX(Math.PI / 2); }
      else geometry = new THREE.SphereGeometry(part.radius, 10, 8);
      geometry.applyMatrix4(new THREE.Matrix4().fromArray(part.matrix!).transpose());
    }
    geometry.deleteAttribute('uv');
    geometry.applyMatrix4(transform);
    geometry.computeVertexNormals();
    let color = palette[part.material] ?? part.color ?? '#e4ede5';
    if (kind === 'boat' && part.color) {
      const c = new THREE.Color(part.color);
      if (c.r > c.g * 1.35) color = '#f39a43';
      else if (c.r < 0.18 && c.g < 0.18) color = '#173745';
    }
    const bucket = groups.get(color) ?? []; bucket.push(geometry); groups.set(color, bucket);
  });
  const geometries = Array.from(groups, ([color, list]) => {
    const geometry = mergeGeometries(list)!; list.forEach(g => g.dispose());
    return { geometry, color };
  });
  const bounds = new THREE.Box3(); geometries.forEach(({geometry}) => { geometry.computeBoundingBox(); bounds.union(geometry.boundingBox!); });
  const dimensions = bounds.getSize(new THREE.Vector3());
  const scale = kind === 'boat' ? 60 / dimensions.z : kind === 'copter' ? 42 / Math.max(dimensions.x, dimensions.z) : kind === 'plane' ? 100 / Math.max(dimensions.x, dimensions.z) : 62 / dimensions.y;
  return { geometries, scale };
}

function Vehicle({ model, kind }: { model: Models[string]; kind: string }) {
  const { geometries, scale } = useMemo(() => buildModel(model, kind), [model, kind]);
  useEffect(() => () => geometries.forEach(({geometry}) => geometry.dispose()), [geometries]);
  return <group scale={scale}>{geometries.map(({ geometry, color }) => <mesh key={color} geometry={geometry} castShadow receiveShadow><meshStandardMaterial color={color} roughness={0.72} metalness={0.08} flatShading side={kind==='boat'?THREE.DoubleSide:THREE.FrontSide}/></mesh>)}</group>;
}

function Terrain({ world, tileX, tileZ }: { world: WorldData; tileX: number; tileZ: number }) {
  const geometry = useMemo(() => {
    const side = tileX === 0 && tileZ === 0 ? world.size : 129, size = world.half * 2;
    const base = new THREE.PlaneGeometry(size, size, side - 1, side - 1); base.rotateX(-Math.PI / 2);
    const positions = base.getAttribute('position');
    for (let i = 0; i < positions.count; i++) {
      const height = sampleRiverHeight(world, positions.getX(i) + tileX * size, positions.getZ(i) + tileZ * size);
      positions.setY(i, height < world.waterLevel ? -7 : height);
    }
    const g = base.toNonIndexed(); base.dispose(); g.computeVertexNormals();
    const p = g.getAttribute('position'), n = g.getAttribute('normal'), colors: number[] = [];
    const snow = new THREE.Color('#e6efea'), rock = new THREE.Color('#6b858c'), shore = new THREE.Color('#a1b9b6');
    for (let i = 0; i < p.count; i++) {
      const h = p.getY(i), slope = n.getY(i);
      const c = snow.clone().lerp(rock, Math.max(0, 0.88 - slope) * 1.5);
      if (h < 30) c.lerp(shore, (30 - h) / 45);
      const grain = Math.sin((p.getX(i)+tileX*size)*0.017+(p.getZ(i)+tileZ*size)*0.014)*0.017;
      c.offsetHSL(0, 0, grain); colors.push(c.r,c.g,c.b);
    }
    g.setAttribute('color',new THREE.Float32BufferAttribute(colors,3)); return g;
  }, [world, tileX, tileZ]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <mesh geometry={geometry} position={[tileX*world.half*2,0,tileZ*world.half*2]} receiveShadow><meshStandardMaterial vertexColors roughness={0.97} flatShading/></mesh>;
}

/** Keep just the current reach and its neighbours; all tiles share one world sampler. */
function RiverTerrain({ world, state }: { world: WorldData; state: MutableRefObject<GameState> }) {
  const [sector, setSector] = useState(() => getSector(world, state.current.boat.x, state.current.boat.z));
  const current = useRef(sector);
  useFrame(() => {
    const next = getSector(world, state.current.boat.x, state.current.boat.z);
    if (next.sectorX !== current.current.sectorX || next.sectorZ !== current.current.sectorZ) {
      current.current = next;
      setSector(next);
    }
  });
  const tiles = [];
  for (let x = sector.sectorX - 1; x <= sector.sectorX + 1; x++) {
    for (let z = sector.sectorZ - 1; z <= sector.sectorZ + 1; z++) {
      tiles.push(<Terrain key={`${x}:${z}`} world={world} tileX={x} tileZ={z}/>);
    }
  }
  return <>{tiles}</>;
}

function BoostPickups({ state, world, clock, reducedMotion }: { state: MutableRefObject<GameState>; world: WorldData; clock: MutableRefObject<number>; reducedMotion: boolean }) {
  const markers = useRef<(THREE.Group | null)[]>([]);
  useFrame(() => {
    markers.current.forEach((marker, i) => {
      if (!marker) return;
      const pickup = state.current.pickups[i];
      marker.visible = Boolean(pickup) && state.current.status !== 'ready';
      if (!pickup) return;
      const bob = reducedMotion ? 0 : Math.sin(clock.current * 1.8 + pickup.id) * 2;
      marker.position.set(pickup.x, world.waterLevel + 23 + bob, pickup.z);
      marker.rotation.y = state.current.initialBoat.heading;
    });
  });
  return <>{Array.from({length: GAME_RULES.maxPickups}, (_, i) => <group key={i} ref={node => {markers.current[i] = node;}} visible={false}>
    <mesh><torusGeometry args={[27, 1.9, 8, 48]}/><meshBasicMaterial color="#f6a04d"/></mesh>
    {[-6, 5].flatMap(y => [-1, 1].map(side => <mesh key={`${y}:${side}`} position={[side*5, y, 0]} rotation={[0, 0, side*Math.PI/4]}><boxGeometry args={[3, 15, 3]}/><meshBasicMaterial color="#ffe0aa"/></mesh>))}
    <mesh rotation={[-Math.PI/2,0,0]} position={[0,-21,0]}><ringGeometry args={[31,36,48]}/><meshBasicMaterial color="#f6a04d" transparent opacity={0.5} side={THREE.DoubleSide} depthWrite={false}/></mesh>
  </group>)}</>;
}

function RadarBeam({ tower, state }: { tower: WorldData['towers'][number]; state: MutableRefObject<GameState> }) {
  const fan = useRef<THREE.Mesh>(null);
  const material = useRef<THREE.MeshBasicMaterial>(null);
  const geometry = useMemo(() => {
    const vertices = [0,0,0]; const indices = [];
    for (let i=0;i<=40;i++) { const a=-GAME_RULES.radarFov/2+i/40*GAME_RULES.radarFov; vertices.push(Math.sin(a)*tower.range,0,Math.cos(a)*tower.range); if(i) indices.push(0,i,i+1); }
    const g = new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));g.setIndex(indices);return g;
  }, [tower.range]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useFrame(() => {
    const t = state.current.towers.find(t => t.id === tower.id)!;
    if (fan.current) fan.current.rotation.y = t.heading;
    if (material.current) { material.current.color.set(t.detecting ? '#f1bd67' : '#b1e9c8'); material.current.opacity = t.detecting ? 0.20 : 0.105; }
  });
  return <group position={[tower.x,3,tower.z]}>
    <mesh ref={fan} geometry={geometry}><meshBasicMaterial ref={material} color="#b1e9c8" transparent opacity={0.105} side={THREE.DoubleSide} depthWrite={false}/></mesh>
    <mesh rotation={[-Math.PI/2,0,0]}><ringGeometry args={[tower.range-3,tower.range,100]}/><meshBasicMaterial color="#b8e9d1" transparent opacity={0.28} depthWrite={false}/></mesh>
  </group>;
}

/** A ground-projected silhouette makes the drone's position legible on the water. */
function DroneShadow({ pose, index, world }: { pose: MutableRefObject<RenderPose>; index: number; world: WorldData }) {
  const group = useRef<THREE.Group>(null);
  useFrame(() => {
    if(!group.current)return;
    const d=pose.current.drones[index];
    const x=d.x,z=d.z;
    const ground=sampleRiverHeight(world,x,z);
    group.current.visible=Number.isFinite(ground)&&ground<=world.waterLevel;
    group.current.position.set(x,world.waterLevel+.9,z);
    group.current.rotation.set(-Math.PI/2,0,-d.heading);
  });
  return <group ref={group}>
    <mesh><circleGeometry args={[27,40]}/><meshBasicMaterial color="#062832" transparent opacity={.10} depthWrite={false}/></mesh>
    {[-1,1].map(direction=><mesh key={direction} rotation={[0,0,direction*Math.PI/4]}><planeGeometry args={[43,5]}/><meshBasicMaterial color="#082731" transparent opacity={.42} depthWrite={false}/></mesh>)}
    <mesh><circleGeometry args={[6,16]}/><meshBasicMaterial color="#082731" transparent opacity={.52} depthWrite={false}/></mesh>
    {[-1,1].flatMap(x=>[-1,1].map(z=><mesh key={`${x}:${z}`} position={[x*14,z*14,.04]}><circleGeometry args={[8,24]}/><meshBasicMaterial color="#082731" transparent opacity={.33} depthWrite={false}/></mesh>))}
  </group>;
}

type AircraftPose = { x:number; z:number; heading:number; altitude:number; speed:number };
type RenderPose = { boat:BoatPose; drones:AircraftPose[]; plane:AircraftPose };
const copyPose = (s:GameState):RenderPose => ({boat:{...s.boat},drones:s.drones.map(d=>({...d})),plane:{...s.plane}});
const blend=(a:number,b:number,alpha:number)=>a+(b-a)*alpha;
function blendAircraft(target:AircraftPose,a:AircraftPose,b:AircraftPose,alpha:number){
  target.x=blend(a.x,b.x,alpha);target.z=blend(a.z,b.z,alpha);target.heading=blend(a.heading,b.heading,alpha);
  target.altitude=blend(a.altitude,b.altitude,alpha);target.speed=blend(a.speed,b.speed,alpha);
}

function World(props: Props) {
  const { world, models, game, input, onUpdate, reducedMotion, onReady, cameraMode, lookBack } = props;
  const boat=useRef<THREE.Group>(null), drones=useRef<(THREE.Group|null)[]>([]), plane=useRef<THREE.Group>(null);
  const clock=useRef(0),report=useRef(0),previousTime=useRef(0),previousStatus=useRef('ready');
  const previousPose=useRef(copyPose(game.current)),pose=useRef(copyPose(game.current));
  const boatPose=useRef(pose.current.boat);
  const previousView=useRef(cameraMode),previousLook=useRef(false);
  const readiness=useRef(0);
  const {camera,gl}=useThree();
  const target=useMemo(()=>new THREE.Vector3(),[]);
  useEffect(()=>{gl.setClearColor('#cadfe0');return ()=>cancelAnimationFrame(readiness.current);},[gl]);
  // Run first: all effects consume the same interpolated pose and clock.
  useFrame((_,rawDelta)=>{
    if (!readiness.current) readiness.current=requestAnimationFrame(onReady);
    const dt=Math.min(rawDelta,.05),s=game.current;
    const reset=s.time<previousTime.current||(previousStatus.current==='ready'&&s.status==='playing');
    if(reset){previousPose.current=copyPose(s);clock.current=0;}
    if(previousStatus.current!==s.status||rawDelta>.5)previousPose.current=copyPose(s);
    if(s.status==='playing'||s.status==='ready')clock.current+=dt;
    stepGame(s,world,input.current,rawDelta,()=>{
      Object.assign(previousPose.current.boat,s.boat);
      s.drones.forEach((d,i)=>Object.assign(previousPose.current.drones[i],d));
      Object.assign(previousPose.current.plane,s.plane);
    });
    const alpha=s.status==='playing'?Math.min(1,s.accumulator/SIMULATION_STEP):1;
    const p=pose.current,old=previousPose.current;
    for(const key of ['x','z','heading','speed','roll'] as const)p.boat[key]=blend(old.boat[key],s.boat[key],alpha);
    s.drones.forEach((d,i)=>blendAircraft(p.drones[i],old.drones[i],d,alpha));
    blendAircraft(p.plane,old.plane,s.plane,alpha);
    boatPose.current=p.boat;
    const b=p.boat,speed=Math.min(1,Math.abs(b.speed)/GAME_RULES.maxSpeed),moving=s.status==='playing';
    const surface=swellHeight(b.x,b.z,clock.current);
    const roll=reducedMotion?0:b.roll*.45;
    const pitch=reducedMotion?0:Math.sin(clock.current*.83+b.z*.002)*.003*speed;
    if(boat.current){boat.current.position.set(b.x,world.waterLevel+surface,b.z);boat.current.rotation.set(pitch,b.heading,roll);}
    p.drones.forEach((d,i)=>{const model=drones.current[i];if(model){model.position.set(d.x,d.altitude,d.z);model.rotation.set(-.055,d.heading,0);}});
    if(plane.current){const a=p.plane;plane.current.position.set(a.x,a.altitude,a.z);plane.current.rotation.set(0,a.heading,0);}
    let fov=48;
    if(s.status==='ready'){
      camera.position.set(world.spawn.x+1700,1750,world.spawn.z+2050);
      target.set(world.spawn.x-300,40,world.spawn.z-220);
    }else{
      const sx=Math.sin(b.heading),sz=Math.cos(b.heading),facing=lookBack.current?-1:1;
      if(cameraMode==='helm'){
        camera.position.set(b.x-sx*14-sz*9,world.waterLevel+32+surface,b.z-sz*14+sx*9);
        const ground=sampleRiverHeight(world,camera.position.x,camera.position.z);
        if(Number.isFinite(ground))camera.position.y=Math.max(camera.position.y,ground+7);
        target.set(b.x+sx*100*facing-sz*9,world.waterLevel-5+surface,b.z+sz*100*facing+sx*9);
        fov=76+(reducedMotion?0:speed*5);
      }else{
        camera.position.set(b.x-sx*175*facing,world.waterLevel+88+surface,b.z-sz*175*facing);
        const ground=sampleRiverHeight(world,camera.position.x,camera.position.z);
        if(Number.isFinite(ground))camera.position.y=Math.max(camera.position.y,ground+40);
        target.set(b.x+sx*100*facing,world.waterLevel+12+surface,b.z+sz*100*facing);
        fov=55+(reducedMotion?0:speed*4);
      }
    }
    const lens=camera as THREE.PerspectiveCamera;
    const cut=reset||previousView.current!==cameraMode||previousLook.current!==lookBack.current;
    if(cut||s.status==='ready')lens.fov=fov;
    else if(moving)lens.fov+=(fov-lens.fov)*(1-Math.exp(-dt*4));
    lens.updateProjectionMatrix();
    // Interpolation provides smoothness; camera and hull never use competing lags.
    camera.up.set(0,1,0);camera.lookAt(target);
    if(!reducedMotion&&s.status!=='ready')camera.rotateZ(roll*.1);
    previousTime.current=s.time;previousStatus.current=s.status;previousView.current=cameraMode;previousLook.current=lookBack.current;
    report.current+=dt;if(report.current>.08){report.current=0;onUpdate();}
  },-1);
  return <>
    <fog attach="fog" args={['#cadfe0',2200,8500]}/>
    <hemisphereLight args={['#eefbff','#74969a',1.7]}/>
    <directionalLight position={[-1900,3000,1500]} intensity={2.6} color="#fff4dc"/>
    <Ocean level={world.waterLevel} clock={clock} pose={boatPose}/><RiverTerrain world={world} state={game}/>
    <BoostPickups state={game} world={world} clock={clock} reducedMotion={reducedMotion}/>
    {world.towers.map(t=><group key={t.id}>
      <group position={[t.x,t.height,t.z]}><Vehicle model={models.tower} kind="tower"/><mesh position={[0,65,0]}><sphereGeometry args={[5,12,8]}/><meshBasicMaterial color="#b7ebc6"/></mesh></group>
      <RadarBeam tower={t} state={game}/>
    </group>)}
    <group ref={boat}><Vehicle model={models.boat} kind="boat"/></group>
    {game.current.drones.map((d,i)=><group key={d.id} ref={node=>{drones.current[i]=node;}}><Vehicle model={models.copter} kind="copter"/><mesh position={[0,-9,6]}><sphereGeometry args={[2.5,12,8]}/><meshBasicMaterial color={i===0?'#f79a61':'#ffd79b'}/></mesh></group>)}
    <group ref={plane}><Vehicle model={models.plane} kind="plane"/></group>
    {game.current.drones.map((d,i)=><DroneShadow key={d.id} pose={pose} index={i} world={world}/>)}
    <FoamWake state={game} pose={boatPose} level={world.waterLevel} clock={clock}/>
  </>;
}

export default function Scene(props: Props) {
  return <Canvas camera={{position:[1700,1750,2300],fov:48,near:1,far:15000}} dpr={[1,1.6]} gl={{antialias:true,alpha:false,powerPreference:'high-performance'}}><World {...props}/></Canvas>;
}
