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

// 9. AnimationLoop
function animate() {
	requestAnimationFrame(animate);

	cube.rotation.x += 0.005;
	cube.rotation.y += 0.01;

	controls.update();
	renderer.render(scene, camera);
}

animate();

// 10. Handle browser resizing
window.addEventListener('resize', () => {
	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();

	renderer.setSize(window.innerWidth, window.innerHeight);
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});
