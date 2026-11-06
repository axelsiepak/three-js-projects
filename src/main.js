import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import './style.css';

// 1. Create the scene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101014);

// 2. Create the camera
const camera = new THREE.PerspectiveCamera(
	75,
	window.innerWidth / window.innerHeight,
	0.1,
	1000
);

camera.position.z = 5;

// 3. Create the renderer
const renderer = new THREE.WebGLRenderer({
	antialias: true
});

renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

document.body.appendChild(renderer.domElement);

// 4. Create geometry
const geometry = new THREE.BoxGeometry(2, 2, 2);

// 5. Create material
const material = new THREE.MeshStandardMaterial({
	color: 0x8b5cf6,
	roughness: 0.3,
	metalness: 0.2
});

// 6. Create the mesh
const cube = new THREE.Mesh(geometry, material);
scene.add(cube);

// 7. Add lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 1);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 3);

directionalLight.position.set(3, 4, 5);
scene.add(directionalLight);

// 8. Add camera control
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const KEY_ROTATE_SPEED = 1.5; // radians per second
const pressedKeys = new Set();
const offset = new THREE.Vector3();
const spherical = new THREE.Spherical();

window.addEventListener('keydown', (event) => {
	if (event.altKey || event.ctrlKey || event.metaKey) return;

	if (event.key.startsWith('Arrow')) {
		event.preventDefault();
		pressedKeys.add(event.key);
	}
});

window.addEventListener('keyup', (event) => pressedKeys.delete(event.key));
window.addEventListener('blur', () => pressedKeys.clear());

function updateKeyboardControls(delta) {
	const horizontal = pressedKeys.has('ArrowRight') - pressedKeys.has('ArrowLeft');
	const vertical = pressedKeys.has('ArrowUp') - pressedKeys.has('ArrowDown');

	if (horizontal === 0 && vertical === 0) return;

	offset.copy(camera.position).sub(controls.target);
	spherical.setFromVector3(offset);
	spherical.theta += horizontal * KEY_ROTATE_SPEED * delta;
	spherical.phi -= vertical * KEY_ROTATE_SPEED * delta;
	spherical.makeSafe();

	camera.position.copy(controls.target).add(offset.setFromSpherical(spherical));
}

// 9. AnimationLoop
let previousTime = performance.now();

function animate(time) {
	const delta = (time - previousTime) / 1000;
	previousTime = time;

	cube.rotation.x += 0.3 * delta;
	cube.rotation.y += 0.6 * delta;

	updateKeyboardControls(delta);
	controls.update();
	renderer.render(scene, camera);
}

renderer.setAnimationLoop(animate);

// 10. Handle browser resizing
window.addEventListener('resize', () => {
	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();

	renderer.setSize(window.innerWidth, window.innerHeight);
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});
