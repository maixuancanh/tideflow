export const PORTS=[{capacity:36,price:0,maxTrucks:4},{capacity:54,price:3000,maxTrucks:6},{capacity:72,price:7500,maxTrucks:8},{capacity:108,price:16000,maxTrucks:8}];
export const NEW_PORT={id:"jade",name:"Jade Harbor",price:3000,capacity:36};
export type EquipmentId='forklift'|'yard-crane';
export type EquipmentInventory={forklifts:number;yardCranes:number};
export type EquipmentAssignment={forklifts:number;yardCranes:number};
export interface EconomyState{activePort?:string;ownedPorts?:string[];ns:number;portIndex:number;trucks:number;craneLevels:number[];extraYardCrane:boolean;receipts:string[];equipmentInventory?:EquipmentInventory;equipmentAssignments?:Record<string,EquipmentAssignment>}
/** View of authoritative server economy. EquipmentInventory is shared ownership;
 * trucks/extraYardCrane describe only the currently selected port after equip. */
export function createEconomy(){
 let state:EconomyState={ns:0,portIndex:0,trucks:4,craneLevels:[0,0,0,0],extraYardCrane:false,receipts:[],equipmentInventory:{forklifts:0,yardCranes:0},equipmentAssignments:{coral:{forklifts:4,yardCranes:1}}};
 let purchaseAction:((id:string)=>Promise<void>)|undefined;
 let equipAction:((equipmentId:EquipmentId,portId:string)=>Promise<void>)|undefined;
 let upgradeAction:((portId:string)=>Promise<void>)|undefined;
 const listeners=new Set<()=>void>();
 const inventory=()=>state.equipmentInventory??{forklifts:0,yardCranes:0};
 const totalPurchased=(id:EquipmentId)=>{const key=id==='forklift'?'forklifts':'yardCranes';const assigned=Object.values(state.equipmentAssignments??{}).reduce((n,a)=>n+(a?.[key]??0),0);const baseline=id==='forklift'?4:(state.ownedPorts??['coral']).length;return assigned+inventory()[key]-baseline;};
 const offers=()=>{const owned=(state.ownedPorts??['coral']).length;const yardCount=totalPurchased('yard-crane');return [{id:'yard-crane',name:'Yard crane',price:5000+Math.max(0,yardCount)*2500,allowed:!state.extraYardCrane},{id:'harbor:jade',name:NEW_PORT.name+' · 36 fixed slots',price:NEW_PORT.price,allowed:!(state.ownedPorts??['coral']).includes('jade')},{id:'truck',name:'Forklift',price:[800,1400,2400,4000][Math.max(0,totalPurchased('forklift'))]??4000,allowed:state.trucks<PORTS[state.portIndex].maxTrucks},...state.craneLevels.map((level,i)=>({id:'crane:'+i,name:(i===3?'Yard crane':'Berth crane 0'+(i+1))+' · level '+(level+1),price:[1000,2200,4500][level]??0,allowed:level<3}))];};
 return {get state(){return state;},get offers(){return offers();},subscribe(f:()=>void){listeners.add(f);return()=>listeners.delete(f);},sync(value:EconomyState){state=value;state.equipmentInventory??={forklifts:0,yardCranes:0};state.equipmentAssignments??={};listeners.forEach(f=>f());},bindPurchase(action:(id:string)=>Promise<void>){purchaseAction=action;},bindEquip(action:(equipmentId:EquipmentId,portId:string)=>Promise<void>){equipAction=action;},bindUpgrade(action:(portId:string)=>Promise<void>){upgradeAction=action;},async purchase(id:string){try{if(!purchaseAction)throw new Error('Harbor session is not connected.');await purchaseAction(id);return{ok:true,message:'Equipment installed at the selected harbor.'};}catch(error){return{ok:false,message:error instanceof Error?error.message:'Could not save the transaction.'};}},async equip(equipmentId:EquipmentId,portId:string){try{if(!equipAction)throw new Error('Harbor session is not connected.');await equipAction(equipmentId,portId);return{ok:true,message:'Equipment equipped at harbor.'};}catch(error){return{ok:false,message:error instanceof Error?error.message:'Could not equip the equipment.'};}},async upgradeCapacity(portId:string){try{if(!upgradeAction)throw new Error('Harbor session is not connected.');await upgradeAction(portId);return{ok:true,message:'Harbor capacity upgraded.'};}catch(error){return{ok:false,message:error instanceof Error?error.message:'Could not upgrade harbor capacity.'};}}};
}
export type Economy=ReturnType<typeof createEconomy>;
