import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import './style.css';

const STAR_COUNT = 60000;
const GALAXY_RADIUS = 6;
const ARM_COUNT = 4;
const ARM_TWIST = 1.1; // radians per unit of distance from the center
const ARM_SPREAD = 0.4;
const ARM_TIGHTNESS = 2.5; // higher values pull stars closer to their arm
const CORE_COLOR = new THREE.Color(0xb8703a);
const EDGE_COLOR = new THREE.Color(0x4a63ff);

// 1. Create the scene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050508);

// 2. Create the camera
const camera = new THREE.PerspectiveCamera(
	60,
	window.innerWidth / window.innerHeight,
	0.1,
	100
);

camera.position.set(0, 7, 8);

// 3. Create the renderer
const renderer = new THREE.WebGLRenderer({
	antialias: true
});

renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

document.body.appendChild(renderer.domElement);

// 4. Create geometry
function randomOffset(distance) {
	const sign = Math.random() < 0.5 ? -1 : 1;

	return Math.random() ** ARM_TIGHTNESS * sign * ARM_SPREAD * Math.sqrt(distance + 0.6);
}

const positions = new Float32Array(STAR_COUNT * 3);
const colors = new Float32Array(STAR_COUNT * 3);
const starColor = new THREE.Color();

for (let i = 0; i < STAR_COUNT; i++) {
	const distance = Math.random() ** 1.15 * GALAXY_RADIUS;
	const armAngle = (i % ARM_COUNT) / ARM_COUNT * Math.PI * 2;
	const angle = armAngle + distance * ARM_TWIST;

	positions[i * 3] = Math.cos(angle) * distance + randomOffset(distance);
	positions[i * 3 + 1] = randomOffset(distance) * 0.35;
	positions[i * 3 + 2] = Math.sin(angle) * distance + randomOffset(distance);

	starColor.lerpColors(CORE_COLOR, EDGE_COLOR, distance / GALAXY_RADIUS);
	starColor.toArray(colors, i * 3);
}

const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

// 5. Create material
function createStarTexture() {
	const size = 32;
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;

	const context = canvas.getContext('2d');
	const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
	gradient.addColorStop(0, '#ffffff');
	gradient.addColorStop(1, '#000000');

	context.fillStyle = gradient;
	context.fillRect(0, 0, size, size);

	return new THREE.CanvasTexture(canvas);
}

const material = new THREE.PointsMaterial({
	size: 0.045,
	alphaMap: createStarTexture(),
	transparent: true,
	vertexColors: true,
	depthWrite: false,
	blending: THREE.AdditiveBlending
});

// 6. Create the points
const galaxy = new THREE.Points(geometry, material);
scene.add(galaxy);

// 7. Add camera control
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxDistance = 30;

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

// 8. AnimationLoop
let previousTime = performance.now();

function animate(time) {
	const delta = (time - previousTime) / 1000;
	previousTime = time;

	galaxy.rotation.y += 0.05 * delta;

	updateKeyboardControls(delta);
	controls.update();
	renderer.render(scene, camera);
}

renderer.setAnimationLoop(animate);

// 9. Handle browser resizing
window.addEventListener('resize', () => {
	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();

	renderer.setSize(window.innerWidth, window.innerHeight);
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});
