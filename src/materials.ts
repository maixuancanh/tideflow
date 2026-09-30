import { Color3, DynamicTexture, Scene, StandardMaterial, Texture } from '@babylonjs/core';
import { seedRandom } from './geometry';

export function palette(scene: Scene) {
  function material(name: string, hex: string, spec = .12) {
    const m = new StandardMaterial(name, scene); m.diffuseColor = Color3.FromHexString(hex); m.specularColor = new Color3(spec, spec, spec); m.specularPower = 40; return m;
  }
  function grain(m: StandardMaterial, amount: number, lines = false) {
    const texture = new DynamicTexture(m.name + '-surface', { width: 512, height: 512 }, scene, false, Texture.TRILINEAR_SAMPLINGMODE);
    const ctx = texture.getContext(); const rand = seedRandom(234);
    ctx.fillStyle = '#eee9db'; ctx.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 23000; i++) { const v = Math.floor(140 + rand() * 90); ctx.fillStyle = `rgba(${v},${v},${v},${amount})`; ctx.fillRect(rand() * 512, rand() * 512, rand() * 2 + .5, rand() * 2 + .5); }
    if (lines) { ctx.strokeStyle = '#a9a797'; ctx.lineWidth = 1.4; for (let y = 0; y < 512; y += 128) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(512, y); ctx.stroke(); } }
    texture.update(); m.diffuseTexture = texture; return m;
  }
  const p = {
    concrete: grain(material('warm limestone', '#ded4b8'), .25, true), edge: grain(material('pale cut stone', '#eee1c4'), .18),
    darkStone: grain(material('wet stone', '#81897b'), .3), stone: grain(material('coastal rock', '#b5aa8c'), .4),
    sand: grain(material('sand', '#d5c697'), .25), soil: grain(material('island soil', '#919373'), .5),
    navy: material('navy painted hull', '#163e4e', .3), redHull: material('antifouling copper', '#8b4a36', .17),
    cream: material('ivory enamel', '#f3e8ca', .24), white: material('white paint', '#fff3d9', .2),
    orange: material('coral crane enamel', '#dc704a', .26), orangeDark: material('crane side panels', '#b95837'),
    steel: material('weathered steel', '#727e7b', .5), roof: grain(material('zinc barrel roof', '#8b9fa6', .4), .12),
    black: material('rubber and rope', '#273a39', .03), glass: material('dark teal windows', '#123e4a', .7),
    yellow: material('ochre cargo', '#d8ac48', .2), blue: material('blue cargo', '#387184', .25), coral: material('red cargo', '#b96043', .17),
    cargoCream: material('cream cargo', '#b7b39c'), line: material('painted safety stripes', '#edd997'),
    leaf: material('olive foliage', '#657d42', .05), leafLight: material('sunlit foliage', '#8c9b51', .07), leafDark: material('deep foliage', '#496546', .05),
    wood: material('tree and crates', '#8b7852'), emissive: material('navigation lights', '#d5f8d5'),
  };
  p.emissive.emissiveColor = Color3.FromHexString('#9cd8c5');
  return p;
}
export type Palette = ReturnType<typeof palette>;
