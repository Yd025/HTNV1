import { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { GameState } from '../lib/game';

export type BoatPose = GameState['boat'];

// Broad, low Arctic swells. The hull and water share the same surface, in metres.
export function swellHeight(x: number, z: number, time: number) {
  return Math.sin(x * .013 + z * .006 - time * .65) * .38
    + Math.sin(x * -.007 + z * .021 - time * .83) * .19
    + Math.sin(x * .026 + z * .019 - time * 1.05) * .08;
}

/** Four points under the hull provide its waterline and local wave slope. */
export function hullWaterPose(x: number, z: number, heading: number, time: number) {
  const forwardX=Math.sin(heading),forwardZ=Math.cos(heading);
  const bow=swellHeight(x+forwardX*28,z+forwardZ*28,time);
  const stern=swellHeight(x-forwardX*28,z-forwardZ*28,time);
  const port=swellHeight(x+forwardZ*11,z-forwardX*11,time);
  const starboard=swellHeight(x-forwardZ*11,z+forwardX*11,time);
  return {height:(bow+stern+port+starboard)/4,pitch:Math.atan2(stern-bow,56),roll:Math.atan2(port-starboard,22)};
}

export function Ocean({ level, clock, pose }: { level: number; clock: MutableRefObject<number>; pose: MutableRefObject<BoatPose> }) {
  const surface = useRef<THREE.Mesh>(null);
  const material = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      varying vec3 vWorld;
      uniform float uTime;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.);
        w.y += sin(w.x*.013+w.z*.006-uTime*.65)*.38
             + sin(w.x*-.007+w.z*.021-uTime*.83)*.19
             + sin(w.x*.026+w.z*.019-uTime*1.05)*.08;
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: `
      varying vec3 vWorld;
      uniform float uTime;
      float hash(vec2 p) { p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
      float noise(vec2 p) {
        vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
      }
      vec2 ripple(vec2 p,vec2 direction,float frequency,float amplitude,float speed) {
        float phase=dot(p,direction)*frequency-uTime*speed+sin(dot(p,vec2(.006,.008)))*.8;
        float filtered=1.-smoothstep(.4,1.8,fwidth(phase));
        return direction*cos(phase)*amplitude*filtered;
      }
      void main() {
        vec2 p=vWorld.xz;
        float a=p.x*.013+p.y*.006-uTime*.65;
        float b=p.x*-.007+p.y*.021-uTime*.83;
        float c=p.x*.026+p.y*.019-uTime*1.05;
        vec2 slope=cos(a)*vec2(.013,.006)*.38+cos(b)*vec2(-.007,.021)*.19+cos(c)*vec2(.026,.019)*.08;
        float distanceToEye=length(cameraPosition-vWorld);
        // Small ripples fade before they become subpixel lines at the horizon.
        float detail=1.-smoothstep(180.,1300.,distanceToEye);
        vec2 ripples=ripple(p,vec2(.82,.57),.17,.014,.75)
          +ripple(p,vec2(.63,.78),.31,.008,1.1)
          +ripple(p,vec2(.94,.34),.53,.005,1.35)
          +ripple(p,vec2(.71,.70),.91,.002,1.7);
        slope+=ripples*detail;
        vec3 n=normalize(vec3(-slope.x,1.,-slope.y));
        vec3 v=normalize(cameraPosition-vWorld);
        float fresnel=.035+.965*pow(1.-max(dot(n,v),0.),4.5);
        vec3 reflection=reflect(-v,n);
        vec3 sky=mix(vec3(.48,.64,.66),vec3(.21,.39,.46),smoothstep(0.,.8,reflection.y));
        float cloud=noise(reflection.xz*4.+vec2(.7,2.))*.10;
        sky+=cloud;
        float variation=noise(p*.002)*.5+noise(p*.007)*.15;
        vec3 sea=mix(vec3(.017,.095,.12),vec3(.03,.17,.19),variation);
        vec3 color=mix(sea,sky,fresnel*.8);
        vec3 sun=normalize(vec3(-.42,.78,.28));
        float highlight=pow(max(dot(n,normalize(v+sun)),0.),180.);
        color+=vec3(.70,.77,.69)*highlight*.14;
        float haze=1.-exp(-distanceToEye*.000055);
        color=mix(color,vec3(.48,.64,.66),haze);
        gl_FragColor=vec4(color,1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }), []);
  useEffect(() => () => material.dispose(), [material]);
  useFrame(() => {
    material.uniforms.uTime.value = clock.current;
    // The geometry follows the boat, while waves stay anchored to world coordinates.
    surface.current?.position.set(Math.round(pose.current.x/500)*500,level,Math.round(pose.current.z/500)*500);
  });
  return <mesh ref={surface} rotation={[-Math.PI/2,0,0]} position={[0,level,0]} material={material}><planeGeometry args={[20000,20000,256,256]}/></mesh>;
}

/** A continuous, fading foam trail, sampled by distance rather than frame rate. */
export function FoamWake({ state, pose, level, clock }: { state: MutableRefObject<GameState>; pose: MutableRefObject<BoatPose>; level: number; clock: MutableRefObject<number> }) {
  const count=100;
  const points=useRef<{x:number;z:number;heading:number;time:number}[]>([]);
  const lastRunTime=useRef(0);
  const geometry=useMemo(()=>{
    const g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.BufferAttribute(new Float32Array(count*2*3),3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv',new THREE.BufferAttribute(new Float32Array(count*2*2),2));
    g.setAttribute('fade',new THREE.BufferAttribute(new Float32Array(count*2),1).setUsage(THREE.DynamicDrawUsage));
    const indices:number[]=[];
    for(let i=0;i<count-1;i++){const n=i*2;indices.push(n,n+1,n+2,n+1,n+3,n+2);}
    g.setIndex(indices);g.setDrawRange(0,0);return g;
  },[]);
  const material=useMemo(()=>new THREE.ShaderMaterial({
    transparent:true,depthWrite:false,side:THREE.DoubleSide,
    vertexShader:`attribute float fade; varying float vFade; varying vec2 vUv; varying vec2 vWorld; void main(){vFade=fade;vUv=uv;vWorld=position.xz;gl_Position=projectionMatrix*viewMatrix*modelMatrix*vec4(position,1.);}`,
    fragmentShader:`varying float vFade;varying vec2 vUv;varying vec2 vWorld;
      float hash(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
      float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
      void main(){float edge=1.-smoothstep(.45,1.,abs(vUv.x*2.-1.));float foam=smoothstep(.22,.8,noise(vWorld*.19));gl_FragColor=vec4(.76,.88,.85,edge*foam*vFade*.38);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`,
  }),[]);
  useEffect(()=>()=>{geometry.dispose();material.dispose();},[geometry,material]);
  useFrame(()=>{
    const s=state.current,b=pose.current,t=clock.current;
    if(s.time<lastRunTime.current||s.status==='ready')points.current=[];
    lastRunTime.current=s.time;
    if(s.status!=='playing'){if(!points.current.length)geometry.setDrawRange(0,0);return;}
    const x=b.x-Math.sin(b.heading)*29,z=b.z-Math.cos(b.heading)*29;
    const latest=points.current[0];
    if(Math.abs(b.speed)>3&&(!latest||Math.hypot(x-latest.x,z-latest.z)>3))points.current.unshift({x,z,heading:b.heading,time:t});
    points.current=points.current.filter(p=>t-p.time<4.5).slice(0,count);
    const position=geometry.getAttribute('position'),uv=geometry.getAttribute('uv'),fade=geometry.getAttribute('fade');
    points.current.forEach((p,i)=>{
      const age=t-p.time,width=4+age*9,alpha=Math.pow(Math.max(0,1-age/4.5),1.5);
      for(let side=0;side<2;side++){
        const sign=side?1:-1,px=p.x+Math.cos(p.heading)*width*sign,pz=p.z-Math.sin(p.heading)*width*sign;
        position.setXYZ(i*2+side,px,level+swellHeight(px,pz,t)+.18,pz);
        uv.setXY(i*2+side,side,i/(count-1));fade.setX(i*2+side,alpha);
      }
    });
    position.needsUpdate=true;uv.needsUpdate=true;fade.needsUpdate=true;
    geometry.setDrawRange(0,Math.max(0,points.current.length-1)*6);
  });
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={2}/>;
}
