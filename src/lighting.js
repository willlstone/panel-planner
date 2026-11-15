import * as THREE from 'three';
import { GradientEquirectTexture, ShapedAreaLight } from 'three-gpu-pathtracer';
import { IN } from './room.js';

// Two rigs:
//  - `shared` lights are real: the path tracer uses them, and the quick preview shows them unshadowed.
//  - `preview` lights exist only for the rasterised preview, standing in for bounce light the
//    path tracer computes properly. They are attached just for the preview draw.
export class Lighting {
  constructor(scene) {
    this.scene = scene;
    this.shared = new THREE.Group(); this.shared.name = 'lights';
    this.preview = new THREE.Group(); this.preview.name = 'preview-lights';
    scene.add(this.shared);
    this.sky = new GradientEquirectTexture(256);
    scene.background = this.sky; scene.environment = this.sky;
    this.envPT = 1; this.envPreview = 0.3;
  }

  _clear(group) {
    for (const c of [...group.children]) { group.remove(c); c.dispose?.(); c.shadow?.map?.dispose(); }
  }

  update(S, stats) {
    this._clear(this.shared); this._clear(this.preview);
    const { w, l, h } = S.room, W = w * IN, L = l * IN, H = h * IN;
    const preset = S.light.preset, wins = stats.windows;
    const centre = new THREE.Vector3(W / 2, H * 0.4, L / 2);
    const span = Math.max(W, L, H);
    const evening = preset === 'evening';

    const sky = { soft: ['#9fc0f5', '#ffffff'], sunny: ['#6ea5f2', '#f4f8ff'], evening: ['#0b1230', '#3a3350'] }[preset];
    this.sky.topColor.set(sky[0]); this.sky.bottomColor.set(sky[1]); this.sky.update();
    this.sky.needsPMREMUpdate = true;
    this.envPT = evening ? 0.2 : 1;   // kept low: the window area light carries the daylight and converges far faster
    this.envPreview = evening ? 0.08 : 0.32;

    // Daylight through each window: a soft area source the size of the opening.
    for (const win of wins) {
      const a = new THREE.RectAreaLight(evening ? '#6f86c9' : preset === 'sunny' ? '#dbe8ff' : '#f6f9ff',
        evening ? 0.6 : preset === 'sunny' ? 12 : 24, win.w, win.h);
      a.position.copy(win.center);
      a.lookAt(win.center.clone().add(win.normal));
      this.shared.add(a);
    }

    const shadowLight = (color, intensity, dir, from) => {
      const d = new THREE.DirectionalLight(color, intensity);
      d.position.copy(from).addScaledVector(dir, -span * 1.6);
      d.target.position.copy(from);
      d.castShadow = true;
      d.shadow.mapSize.set(2048, 2048); d.shadow.bias = -0.0004; d.shadow.normalBias = 0.012;
      Object.assign(d.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 0.1, far: span * 4 });
      d.shadow.camera.updateProjectionMatrix();
      return d;
    };

    this.sunny = false;
    if (wins.length && !evening) {
      const win = wins[0];
      // Direction the light travels: in through the window, angled across the room and down.
      const az = 28 * Math.PI / 180, el = (preset === 'sunny' ? 36 : 24) * Math.PI / 180;
      const dir = win.normal.clone().multiplyScalar(Math.cos(az)).addScaledVector(win.tangent, Math.sin(az))
        .multiplyScalar(Math.cos(el)).add(new THREE.Vector3(0, -Math.sin(el), 0)).normalize();
      if (preset === 'sunny') {
        const sun = shadowLight('#fff0d6', 9, dir, win.center.clone().addScaledVector(dir, span * 0.4));
        this.shared.add(sun, sun.target);
        this.sunny = true;
      } else {
        // preview only: a gentle key from the window side so mouldings show relief while you drag sliders
        const key = shadowLight('#ffffff', 1.1, dir, centre);
        key.castShadow = false;   // trim on the window wall would throw false shadows across the room
        this.preview.add(key, key.target);
      }
    }

    // Recessed ceiling lights for the evening scene, or when the room has no window at all.
    if (evening || wins.length === 0) {
      const c = stats.ceiling, cw = c.x1 - c.x0, cl = c.z1 - c.z0;
      const nx = Math.max(1, Math.round(cw / 1.7)), nz = Math.max(1, Math.round(cl / 1.7));
      const power = evening ? 300 : 200;
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
        const can = new ShapedAreaLight(evening ? '#ffd9a6' : '#fff4e2', power, 0.15, 0.15);
        can.isCircular = true;
        can.position.set(c.x0 + cw * (i + 0.5) / nx, c.y - 0.012, c.z0 + cl * (j + 0.5) / nz);
        can.lookAt(can.position.x, 0, can.position.z);
        this.shared.add(can);
      }
      if (!this.preview.children.length) {
        const key = shadowLight(evening ? '#ffe2bd' : '#ffffff', 0.5, new THREE.Vector3(0.25, -1, -0.3).normalize(), centre);
        this.preview.add(key, key.target);
      }
    }

    // A soft ceiling light in each neighbouring space seen through an open doorway, so it reads as a room.
    for (const stub of stats.stubs) {
      const a = new THREE.RectAreaLight(evening ? '#ffd9a6' : '#f6f4ee', evening ? 28 : 22, 0.5, 0.5);
      a.position.copy(stub.pos);
      a.lookAt(stub.pos.x, 0, stub.pos.z);
      this.shared.add(a);
    }

    const hemi = new THREE.HemisphereLight(evening ? '#ffe3c2' : '#ffffff', evening ? '#6b5a48' : '#cdbfae', evening ? 0.35 : 0.75);
    this.preview.add(hemi);
    for (const g of [this.shared, this.preview]) g.traverse((o) => o.updateMatrixWorld(true));
    this.scene.environmentIntensity = this.envPT;
    this.scene.backgroundIntensity = evening ? 1 : 5;   // the view out of the window blows out, as in a photo
  }

  // Draw the fast preview with the stand-in lights attached, then put the scene back as the path tracer expects it.
  renderPreview(renderer, scene, camera) {
    scene.add(this.preview);
    scene.environmentIntensity = this.envPreview;
    renderer.render(scene, camera);
    scene.remove(this.preview);
    scene.environmentIntensity = this.envPT;
  }
}
