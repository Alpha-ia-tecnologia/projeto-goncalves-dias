import { describe, expect, it } from "vitest";
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Texture } from "three";
import { prepareAvatarSurface } from "../lib/avatar/appearance";

describe("materiais do avatar refinado", () => {
  it("preserva os reflexos dos olhos sem deixar pele e tecido metálicos", () => {
    const avatar = new Group();
    const skin = new MeshStandardMaterial({ roughness: .76, metalness: .5 });
    const iris = new MeshStandardMaterial({ roughness: .24, metalness: 0 });
    const eye = new Mesh(new BoxGeometry(), iris);
    eye.userData.avatarEye = true;
    avatar.add(new Mesh(new BoxGeometry(), skin), eye);
    prepareAvatarSurface(avatar, 8);
    expect(skin.roughness).toBe(.76);
    expect(skin.metalness).toBe(0);
    expect(iris.roughness).toBe(.24);
  });

  it("preserva a cor seletiva da pele, a textura e o shader sincronizado da boca", () => {
    const avatar = new Group();
    const map = new Texture();
    const material = new MeshStandardMaterial({ map, vertexColors: true, roughness: .76 });
    const mouthShader = material.onBeforeCompile;
    const color = material.color.clone();
    avatar.add(new Mesh(new BoxGeometry(), material));
    prepareAvatarSurface(avatar, 2);
    prepareAvatarSurface(avatar, 2);
    expect(material.map).toBe(map);
    expect(map.anisotropy).toBe(2);
    expect(material.vertexColors).toBe(true);
    expect(material.color.equals(color)).toBe(true);
    expect(material.onBeforeCompile).toBe(mouthShader);
  });
});
