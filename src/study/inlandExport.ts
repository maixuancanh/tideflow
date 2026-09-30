import { Color3, Mesh, PBRMaterial, Scene, TransformNode, Vector3 } from '@babylonjs/core';
import { Shapes } from '../geometry';

export const INLAND_EXPORT_HANDOFF = Object.freeze({ x: 9.6, y: 2.45, z: -9 });
const ROAD_X = -7, GATE_Z = -35, ROAD_CENTER_Z = -40.5, VISIBLE_ROAD_LENGTH = 35;
export const INLAND_EXPORT_CARGO_YAW = Math.PI / 2;

/** Local port geometry: a dedicated inland road, outside the warehouse fleet circuit. */
export function createInlandExport(scene: Scene) {
  const root = new TransformNode('Inland export route', scene);
  const vehicle = new TransformNode('Inland tractor trailer', scene); vehicle.parent = root;
  const g = new Shapes(scene), wheels: TransformNode[] = [];
  const material = (name: string, hex: string, metallic = 0) => {
    const m = new PBRMaterial(`Inland ${name}`, scene); m.albedoColor = Color3.FromHexString(hex);
    m.metallic = metallic; m.roughness = .8; return m;
  };
  const earth = material('reclaimed land', '#8B806B'), stone = material('land retaining wall', '#A39B86');
  // Reclaimed ground behind the warehouse: the export road terminates on land, not water.
  g.box('Reclaimed rear land foundation', ROAD_X, .3, -48, 6.6, 2.1, 48, stone, root);
  g.box('Reclaimed rear land surface', ROAD_X, 1.39, -48, 6.6, .08, 48, earth, root);
  const asphalt = material('road', '#69767A'), concrete = material('road deck', '#B2AD97');
  const paint = material('lane paint', '#F3DC92'), steel = material('steel', '#45565C', .4);
  const cab = material('cab', '#DD985B'), glass = material('window', '#31525C');
  const rubber = material('tyres', '#273235'), light = material('lamps', '#F9E6B4');
  g.box('Export raised road deck', ROAD_X, 1.05, ROAD_CENTER_Z, 5, .8, VISIBLE_ROAD_LENGTH, concrete, root);
  g.box('Export asphalt', ROAD_X, 1.47, ROAD_CENTER_Z, 4.7, .06, VISIBLE_ROAD_LENGTH, asphalt, root);
  for (const x of [ROAD_X-2.2, ROAD_X+2.2]) {
    g.box('Export road edge', x, 1.515, ROAD_CENTER_Z, .08, .025, VISIBLE_ROAD_LENGTH, paint, root, .01);
    g.box('Export curb', x + (x < ROAD_X ? -.12 : .12), 1.6, ROAD_CENTER_Z, .16, .3, VISIBLE_ROAD_LENGTH, concrete, root);
  }
  for (let z = -55; z <= -25; z += 5) g.box('Export road marker', ROAD_X, 1.515, z, .1, .025, 1.5, paint, root, .01);
  // Road starts at z=-23, near the rear of the warehouse. The front apron stays clear.
  for (const x of [ROAD_X-2.3, ROAD_X+2.3]) g.box('Inland gate pillar', x, 3.3, GATE_Z, .3, 4, .3, steel, root);
  g.box('Inland gate header', ROAD_X, 5.4, GATE_Z, 4.9, .25, .35, paint, root);
  g.box('Trailer underframe', 0, 1.93, 0, 2.3, .3, 6.3, steel, vehicle);
  g.box('Container trailer platform', 0, 2.19, 0, 2.55, .12, 6.3, concrete, vehicle);
  g.box('Tractor chassis', 0, 1.94, 4.15, 2.15, .3, 3.1, steel, vehicle);
  g.box('Tractor cabin', 0, 2.98, 4.6, 2.2, 1.75, 2.1, cab, vehicle, .15);
  g.box('Tractor windshield', 0, 3.32, 5.66, 1.85, .67, .025, glass, vehicle, .015);
  for (const x of [-1.11, 1.11]) g.box('Tractor side window', x, 3.3, 4.65, .025, .7, 1.4, glass, vehicle, .01);
  g.box('Tractor bumper', 0, 2.12, 5.73, 2.3, .22, .18, steel, vehicle);
  for (const x of [-.8, .8]) g.box('Tractor headlamp', x, 2.52, 5.66, .35, .2, .04, light, vehicle);
  for (const z of [-2.35, -1.35, 2.7, 4.9]) for (const x of [-1.17, 1.17]) {
    const roll = new TransformNode('Inland rolling wheel', scene); roll.parent = vehicle; roll.position.set(x, 1.79, z);
    const tyre = g.cylinder('Inland tyre', 0, 0, 0, .47, .28, rubber, roll); tyre.rotation.z = Math.PI / 2;
    const hub = g.cylinder('Inland wheel hub', Math.sign(x) * .15, 0, 0, .23, .04, steel, roll); hub.rotation.z = Math.PI / 2;
    g.box('Inland wheel spoke', Math.sign(x) * .18, 0, 0, .025, .37, .07, concrete, roll, .01);
    wheels.push(roll);
  }
  const smooth = (v: number) => { const t = Math.max(0, Math.min(1, v)); return t * t * (3 - 2 * t); };
  const path = (t:number) => {
    const garage=new Vector3(ROAD_X,INLAND_EXPORT_HANDOFF.y,-22);
    const corner=new Vector3(ROAD_X,INLAND_EXPORT_HANDOFF.y,-9);
    const handoff=new Vector3(INLAND_EXPORT_HANDOFF.x,INLAND_EXPORT_HANDOFF.y,INLAND_EXPORT_HANDOFF.z);
    if(t<1.5)return {position:Vector3.Lerp(garage,corner,smooth(t/1.5)),yaw:0};
    if(t<2)return {position:corner,yaw:smooth((t-1.5)/.5)*Math.PI/2};
    if(t<4)return {position:Vector3.Lerp(corner,handoff,smooth((t-2)/2)),yaw:Math.PI/2};
    if(t<=8)return {position:handoff,yaw:Math.PI/2};
    if(t<10)return {position:Vector3.Lerp(handoff,corner,smooth((t-8)/2)),yaw:Math.PI/2};
    if(t<10.5)return {position:corner,yaw:Math.PI/2+smooth((t-10)/.5)*Math.PI/2};
    return {position:Vector3.Lerp(corner,new Vector3(ROAD_X,INLAND_EXPORT_HANDOFF.y,-54),smooth((t-10.5)/3.5)),yaw:Math.PI};
  };
  const cargoPosition = (t:number) => path(t).position;
  let previous=path(0).position;
  let currentYaw=0;
  const update = (t:number) => {
    const time=Number.isFinite(t)?Math.max(0,t):0,pose=path(time);
    vehicle.position.set(pose.position.x,.2,pose.position.z);vehicle.rotation.y=pose.yaw;currentYaw=pose.yaw;
    vehicle.setEnabled(time<14);
    const delta=Vector3.Dot(pose.position.subtract(previous),new Vector3(Math.sin(pose.yaw),0,Math.cos(pose.yaw)));previous=pose.position.clone();
    for(const wheel of wheels)wheel.rotation.x+=delta/.47;
    return {position:pose.position,angle:pose.yaw+Math.PI/2,finished:time>=14};
  };
  const reset = () => { vehicle.setEnabled(false); vehicle.position.set(ROAD_X, .2, -22); for (const wheel of wheels) wheel.rotation.x = 0; };
  reset();
  const meshes = root.getChildMeshes().filter((mesh): mesh is Mesh => mesh instanceof Mesh);
  return { root, vehicle, meshes, cargoPosition, get cargoYaw(){return currentYaw+Math.PI/2;}, update, reset };
}
