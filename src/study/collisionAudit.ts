import { harborOutline } from './harborFootprint';
export type Point=[number,number];
export type Pose={x:number,z:number,a:number};
export function rectangle(p:Pose,left:number,right:number,back:number,front:number):Point[]{
  return [[left,back],[right,back],[right,front],[left,front]].map(([x,z])=>[p.x+Math.cos(p.a)*x+Math.sin(p.a)*z,p.z-Math.sin(p.a)*x+Math.cos(p.a)*z]);
}
export function overlaps(a:Point[],b:Point[]){
  for(const polygon of [a,b])for(let i=0;i<polygon.length;i++){
    const p=polygon[i],q=polygon[(i+1)%polygon.length],axis:[number,number]=[p[1]-q[1],q[0]-p[0]];
    const pa=a.map(v=>v[0]*axis[0]+v[1]*axis[1]),pb=b.map(v=>v[0]*axis[0]+v[1]*axis[1]);
    if(Math.max(...pa)<=Math.min(...pb)||Math.max(...pb)<=Math.min(...pa))return false;
  }return true;
}
export function inside(p:Point,polygon:Point[]){let result=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const a=polygon[i],b=polygon[j];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])result=!result;
  }return result;
}
const ground:Point[]=[[-14.5,-25.215],...harborOutline.slice(1),[-14.5,-4.1]];
ground.splice(1,0,[14.5,-25.215]);
export function supported(poly:Point[]){return poly.every(p=>inside(p,ground));}
export function hullHitsQuay(poly:Point[]){
  if(poly.some(p=>inside(p,ground))||ground.some(p=>inside(p,poly)))return true;
  const cross=(a:Point,b:Point,c:Point)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  for(let i=0;i<poly.length;i++)for(let j=0;j<ground.length;j++){
    const a=poly[i],b=poly[(i+1)%poly.length],c=ground[j],d=ground[(j+1)%ground.length];
    if(cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0)return true;
  }return false;
}
