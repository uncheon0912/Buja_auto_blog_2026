import {
  EdgesGeometry, Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial,
  OctahedronGeometry, OrthographicCamera, Scene, TorusGeometry, WebGLRenderer
} from './2026-11-18-three.module.js';

export function createStudioScene(mark, reducedMotion, finePointer) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('webgl2', { alpha: true, antialias: true });
  if (!context) return null;
  const renderer = new WebGLRenderer({ canvas, context, alpha: true, antialias: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));

  const scene = new Scene();
  const camera = new OrthographicCamera(-1.4, 1.4, 1.4, -1.4, 0.1, 12);
  camera.position.z = 5;
  const sculpture = new Group();
  scene.add(sculpture);

  const gemGeometry = new OctahedronGeometry(0.78);
  const gemMaterial = new MeshBasicMaterial({ color: 0x2d8f81, transparent: true, opacity: 0.78 });
  const wireMaterial = new LineBasicMaterial({ color: 0x8ff5db, transparent: true, opacity: 0.82 });
  const edgeGeometry = new EdgesGeometry(gemGeometry);
  const orbitGeometry = new TorusGeometry(0.98, 0.018, 8, 48);
  const orbitMaterial = new MeshBasicMaterial({ color: 0x8ff5db, transparent: true, opacity: 0.76 });
  const orbit = new Mesh(orbitGeometry, orbitMaterial);
  orbit.rotation.x = 0.93;
  orbit.rotation.y = 0.28;
  sculpture.add(new Mesh(gemGeometry, gemMaterial), new LineSegments(edgeGeometry, wireMaterial), orbit);

  let animation = 0;
  let disposed = false;
  const resting = { x: 0.37, y: -0.43, z: -0.21 };
  sculpture.rotation.set(resting.x, resting.y, resting.z);
  mark.append(canvas);

  function draw() {
    renderer.render(scene, camera);
    mark.dataset.scene = 'webgl';
  }

  function render(dark) {
    if (disposed) return;
    cancelAnimationFrame(animation);
    animation = 0;
    if (reducedMotion.matches || document.hidden) {
      mark.removeAttribute('data-scene');
      return;
    }
    const { width, height } = mark.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    const light = dark ? 0x9fefd7 : 0x087365;
    gemMaterial.color.set(dark ? 0x2c8f80 : 0x57b9a5);
    wireMaterial.color.set(light);
    orbitMaterial.color.set(light);
    sculpture.rotation.set(resting.x, resting.y, resting.z);
    draw();
  }

  function aim(event) {
    if (disposed || !finePointer.matches || reducedMotion.matches || document.hidden) return;
    const { left, width, top, height } = mark.getBoundingClientRect();
    const x = event.type === 'pointerleave' ? 0 : (event.clientX - left) / width - 0.5;
    const y = event.type === 'pointerleave' ? 0 : (event.clientY - top) / height - 0.5;
    const goalX = resting.x + y * 0.84;
    const goalY = resting.y + x * 1.24;
    cancelAnimationFrame(animation);
    const start = performance.now();
    const fromX = sculpture.rotation.x;
    const fromY = sculpture.rotation.y;
    function animate(time) {
      if (disposed || document.hidden || reducedMotion.matches) return;
      const fraction = Math.min(1, (time - start) / 170);
      const eased = 1 - (1 - fraction) ** 3;
      sculpture.rotation.x = fromX + (goalX - fromX) * eased;
      sculpture.rotation.y = fromY + (goalY - fromY) * eased;
      draw();
      animation = fraction < 1 ? requestAnimationFrame(animate) : 0;
    }
    animation = requestAnimationFrame(animate);
  }

  const resize = new ResizeObserver(() => render(document.documentElement.dataset.theme === 'dark'));
  mark.addEventListener('pointermove', aim);
  mark.addEventListener('pointerleave', aim);
  resize.observe(mark);
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(animation);
    resize.disconnect();
    mark.removeEventListener('pointermove', aim);
    mark.removeEventListener('pointerleave', aim);
    for (const resource of [gemGeometry, gemMaterial, edgeGeometry, wireMaterial, orbitGeometry, orbitMaterial, renderer]) resource.dispose();
    canvas.remove();
    mark.removeAttribute('data-scene');
  }
  canvas.addEventListener('webglcontextlost', dispose, { once: true });
  window.addEventListener('pagehide', event => { if (!event.persisted) dispose(); });
  return { render, dispose };
}
