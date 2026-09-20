import { useEffect, useMemo, useRef } from 'react';
import { GAME_RULES, type GameState, type WorldData } from '../lib/game';

export default function Radar({ world, state }: { world: WorldData; state: GameState }) {
  const ref=useRef<HTMLCanvasElement>(null);
  const terrain=useMemo(()=>{
    const c=document.createElement('canvas');c.width=world.size;c.height=world.size;
    const ctx=c.getContext('2d')!, image=ctx.createImageData(c.width,c.height);
    world.heights.forEach((h,i)=>{const land=h>world.waterLevel;const shade=Math.min(h/252,1);image.data.set(land?[98+shade*68,134+shade*54,139+shade*48,255]:[29,68,81,255],i*4);});
    ctx.putImageData(image,0,0);return c;
  },[world]);
  useEffect(()=>{
    const ctx=ref.current?.getContext('2d');if(!ctx)return;
    const size=440, margin=12, span=size-margin*2, ratio=span/(world.half*2);
    const point=(x:number,z:number)=>[margin+(x+world.half)*ratio,margin+(z+world.half)*ratio];
    const label=(text:string,x:number,y:number,color:string,side:1|-1=1)=>{
      ctx.font='600 29px Plex, sans-serif';
      const width=ctx.measureText(text).width+12;
      const left=Math.max(3,Math.min(size-width-3,side===1?x+15:x-width-15));
      const top=Math.max(3,Math.min(size-36,y-34));
      ctx.fillStyle='#153642e8';ctx.fillRect(left,top,width,34);
      ctx.fillStyle=color;ctx.textBaseline='middle';ctx.fillText(text,left+6,top+17);ctx.textBaseline='alphabetic';
    };
    ctx.clearRect(0,0,size,size);ctx.fillStyle='#173d4c';ctx.fillRect(0,0,size,size);ctx.drawImage(terrain,margin,margin,span,span);
    state.towers.forEach((t,i)=>{
      const [x,y]=point(t.x,t.z),r=t.range*ratio;
      const angle=Math.PI/2-t.heading;
      ctx.beginPath();ctx.moveTo(x,y);ctx.arc(x,y,r,angle-GAME_RULES.radarFov/2,angle+GAME_RULES.radarFov/2);ctx.closePath();ctx.fillStyle=t.detecting?'#f4ad4d4d':'#a8dcbd25';ctx.fill();
      ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.strokeStyle='#bee9cb66';ctx.setLineDash([5,6]);ctx.lineWidth=1.5;ctx.stroke();ctx.setLineDash([]);
      ctx.beginPath();ctx.arc(x,y,7,0,Math.PI*2);ctx.fillStyle='#c9f1cc';ctx.fill();label(`T${i+1}`,x,y,'#c9f1cc');
    });
    const [px,py]=point(state.plane.x,state.plane.z);
    ctx.save();ctx.translate(px,py);ctx.rotate(-state.plane.heading);ctx.beginPath();ctx.moveTo(0,17);ctx.lineTo(-5,2);ctx.lineTo(-19,-6);ctx.lineTo(-19,-10);ctx.lineTo(-4,-6);ctx.lineTo(-3,-16);ctx.lineTo(0,-13);ctx.lineTo(3,-16);ctx.lineTo(4,-6);ctx.lineTo(19,-10);ctx.lineTo(19,-6);ctx.lineTo(5,2);ctx.closePath();ctx.fillStyle='#9de9f1';ctx.strokeStyle='#153642';ctx.lineWidth=3;ctx.fill();ctx.stroke();ctx.restore();
    label(state.plane.id,px,py,'#9de9f1',-1);
    state.drones.forEach((drone,i)=>{
      const [dx,dy]=point(drone.x,drone.z);
      ctx.strokeStyle=drone.tagProgress>0?'#ffd8b8':'#f5a66b';ctx.lineWidth=4;
      ctx.beginPath();ctx.moveTo(dx-8,dy-8);ctx.lineTo(dx+8,dy+8);ctx.moveTo(dx-8,dy+8);ctx.lineTo(dx+8,dy-8);ctx.stroke();
      ctx.beginPath();ctx.arc(dx,dy,14,0,Math.PI*2);ctx.stroke();
      label(drone.id,dx,dy+(i===1?37:0),'#ffbc89',i===0?1:-1);
    });
    const [x,y]=point(state.boat.x,state.boat.z),h=state.boat.heading;ctx.save();ctx.translate(x,y);ctx.rotate(-h);ctx.beginPath();ctx.moveTo(0,12);ctx.lineTo(-7,-8);ctx.lineTo(0,-4);ctx.lineTo(7,-8);ctx.closePath();ctx.fillStyle='#fffaf0';ctx.strokeStyle='#153642';ctx.lineWidth=2;ctx.fill();ctx.stroke();ctx.restore();
    if(state.lastKnown && state.alert==='searching'){const [kx,ky]=point(state.lastKnown.x,state.lastKnown.z);ctx.strokeStyle='#ffbb7499';ctx.setLineDash([3,4]);ctx.beginPath();ctx.arc(kx,ky,13,0,Math.PI*2);ctx.stroke();ctx.setLineDash([]);}
  },[world,state,terrain]);
  return <div className="radar"><div className="radar-heading"><span>Fort Ross</span><span>6.5 km</span></div><canvas width="440" height="440" ref={ref} role="img" aria-label={`Radar map: your boat, two tower coverage areas, drones ${state.drones.map(drone=>`${drone.id} at ${Math.round(drone.distanceToBoat)} metres`).join(' and ')}, and scout plane ${state.plane.id}.`}/><div className="radar-legend"><span><i className="boat-dot"/>You</span><span><i className="tower-dot"/>Towers</span><span><i className="drone-dot"/>Drones</span><span><i className="plane-dot"/>{state.plane.id} scout</span></div></div>;
}
