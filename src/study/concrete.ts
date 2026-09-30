import { Color3, DynamicTexture, MeshBuilder, PBRMaterial, Scene, Texture } from '@babylonjs/core';

/** A continuous concrete wearing course covers the exaggerated slab recesses. */
export async function concreteApron(scene: Scene) {
  const image = new Image();
  image.src = '/study/concrete-color.jpg';
  await image.decode();
  const color = new DynamicTexture('Exposed fine concrete aggregate', 2048, scene, true);
  const ctx = color.getContext() as CanvasRenderingContext2D;
  ctx.drawImage(image, 0, 0, 2048, 2048);
  const pixels = ctx.getImageData(0, 0, 2048, 2048);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const grain = pixels.data[i] * .3 + pixels.data[i + 1] * .59 + pixels.data[i + 2] * .11;
    // Preserve the scan's aggregate and pores, with sun-bleached cement coloration.
    pixels.data[i] = 143 + grain * .34;
    pixels.data[i + 1] = 142 + grain * .32;
    pixels.data[i + 2] = 135 + grain * .30;
  }
  ctx.putImageData(pixels, 0, 0); color.update();
  color.wrapU = Texture.WRAP_ADDRESSMODE; color.wrapV = Texture.WRAP_ADDRESSMODE;
  color.uScale = 9.66; color.vScale = 3;
  const normal = new Texture('/study/concrete-normal.jpg', scene, false, false);
  normal.uScale = color.uScale; normal.vScale = color.vScale; normal.level = .32;
  const rough = new Texture('/study/concrete-rough.jpg', scene, false, false);
  rough.uScale = color.uScale; rough.vScale = color.vScale; rough.gammaSpace = false;
  const material = new PBRMaterial('Cast concrete wearing course', scene);
  material.albedoTexture = color; material.bumpTexture = normal;
  material.metallic = 0; material.roughness = .96;
  material.metallicTexture = rough;
  material.useRoughnessFromMetallicTextureAlpha = false;
  material.useRoughnessFromMetallicTextureGreen = true;
  material.useMetallnessFromMetallicTextureBlue = false;
  material.environmentIntensity = .35;
  const surface = MeshBuilder.CreateGround('Continuous concrete apron', {width:28.98,height:8.97}, scene);
  surface.position.set(0,1.409,-8); surface.material = material; surface.receiveShadows = true;

  // Thin, low-contrast expansion cuts instead of deep square paving gaps.
  const joint = new PBRMaterial('Subtle concrete expansion cut', scene);
  joint.albedoColor = new Color3(.45,.44,.40); joint.roughness = 1; joint.metallic = 0;
  joint.alpha = .15;
  for (const x of [-8.7,-2.9,2.9,8.7]) {
    const line = MeshBuilder.CreateGround('Faint expansion cut', {width:.014,height:8.94}, scene);
    line.position.set(x,1.411,-8); line.material = joint; line.receiveShadows = true;
  }
  return surface;
}
