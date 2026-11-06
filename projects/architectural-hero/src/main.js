import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import './style.css';

const MAX_PIXEL_RATIO = 1.5; // the post-processing is costly on high density screens
const KEY_ROTATE_SPEED = 1.5; // radians per second
const FADE_DURATION = 0.9; // seconds of fade to black at each cut
const EXPLORE_DUSK = 0.74; // time of day held while the viewer explores
const EXPLORE_VIEW = { position: [26, 11, 42], target: [0, 4, 2], fov: 32 }; // where exploring starts
const TEXTURE_METERS = 4; // size in meters covered by one repeat of a material texture

const LENS_SHIFT_X = 0.13; // moves the house away from the copy, as a fraction of the frame

// Each shot moves the camera from one pose to another. As in architectural
// photography, the low shots keep the camera level so that verticals stay
// vertical, and shift the lens (shiftY, a fraction of the frame) to frame the house.
const SHOTS = [
	{
		duration: 11,
		fov: [27, 25],
		shiftY: [0.22, 0.22],
		from: { position: [-42, 2.4, 58], target: [-2, 2.4, 0] },
		to: { position: [-27, 2.4, 40], target: [1, 2.4, 0] }
	},
	{
		duration: 10,
		fov: [34, 34],
		shiftY: [0.26, 0.26],
		from: { position: [-31, 1.5, 17], target: [-2, 1.5, 2] },
		to: { position: [-21, 1.5, 19.5], target: [3, 1.5, 2] }
	},
	{
		duration: 10,
		fov: [48, 46],
		shiftY: [0.14, 0.14],
		from: { position: [15, 1.5, 17.2], target: [1, 1.5, -5] },
		to: { position: [7, 1.5, 17.2], target: [-3, 1.5, -5] }
	},
	{
		duration: 13,
		fov: [30, 32],
		shiftY: [0.2, 0.02],
		from: { position: [31, 2.2, 33], target: [0, 2.2, 2] },
		to: { position: [38, 19, 44], target: [-1, 3.4, 2] }
	}
];

const FILM_DURATION = SHOTS.reduce((total, shot) => total + shot.duration, 0);
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// 1. Create the scene
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0xffffff, 0.0052);

// 2. Create the camera
const camera = new THREE.PerspectiveCamera(
	30,
	window.innerWidth / window.innerHeight,
	0.1,
	1200
);

// 3. Create the renderer
const renderer = new THREE.WebGLRenderer({
	antialias: false // the multisampled composer target handles it
});

renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

document.body.prepend(renderer.domElement);

// 4. Create the sky
const sunDirection = new THREE.Vector3();

const skyMaterial = new THREE.ShaderMaterial({
	side: THREE.BackSide,
	depthWrite: false,
	fog: false,
	uniforms: {
		zenith: { value: new THREE.Color() },
		horizon: { value: new THREE.Color() },
		glow: { value: new THREE.Color() },
		sunDirection: { value: sunDirection }
	},
	vertexShader: /* glsl */`
		varying vec3 vDirection;

		void main() {
			vDirection = position;
			gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
		}
	`,
	fragmentShader: /* glsl */`
		uniform vec3 zenith;
		uniform vec3 horizon;
		uniform vec3 glow;
		uniform vec3 sunDirection;
		varying vec3 vDirection;

		float hash(vec2 p) {
			return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
		}

		float noise(vec2 p) {
			vec2 i = floor(p);
			vec2 f = fract(p);
			vec2 u = f * f * (3.0 - 2.0 * f);

			return mix(
				mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
				mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
				u.y
			);
		}

		float fbm(vec2 p) {
			float value = 0.0;
			float amplitude = 0.5;

			for (int i = 0; i < 5; i++) {
				value += noise(p) * amplitude;
				p = p * 2.03 + 17.0;
				amplitude *= 0.5;
			}

			return value;
		}

		void main() {
			vec3 direction = normalize(vDirection);
			float height = clamp(direction.y, 0.0, 1.0);
			float sun = max(dot(direction, sunDirection), 0.0);

			vec3 color = mix(horizon, zenith, pow(height, 0.5));
			color += glow * (pow(sun, 4.0) * 0.4 + pow(sun, 28.0) * 0.6 + pow(sun, 1200.0) * 8.0);

			// Long, thin clouds caught by the sun
			vec2 cloudPosition = direction.xz / (direction.y + 0.14);
			float clouds = smoothstep(0.42, 0.95, fbm(cloudPosition * vec2(0.5, 1.3)));
			vec3 cloudColor = mix(horizon * 1.05, glow * 1.5, sun * sun);
			color = mix(color, cloudColor, clouds * smoothstep(0.0, 0.14, direction.y) * 0.55);

			gl_FragColor = vec4(color, 1.0);
		}
	`
});

const sky = new THREE.Mesh(new THREE.SphereGeometry(800, 32, 16), skyMaterial);
sky.renderOrder = -1;
sky.frustumCulled = false;
scene.add(sky);

// 5. Create the materials
function createTexture(size, draw) {
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	draw(canvas.getContext('2d'), size);

	const texture = new THREE.CanvasTexture(canvas);
	texture.wrapS = THREE.RepeatWrapping;
	texture.wrapT = THREE.RepeatWrapping;
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

	return texture;
}

function speckle(context, size, count, alpha) {
	for (let i = 0; i < count; i++) {
		const shade = Math.random() < 0.5 ? 0 : 255;

		context.fillStyle = `rgb(${shade} ${shade} ${shade} / ${Math.random() * alpha})`;
		context.fillRect(Math.random() * size, Math.random() * size, 1 + Math.random() * 2, 1 + Math.random() * 2);
	}
}

// Board-formed concrete: horizontal planks with visible joints
const concreteTexture = createTexture(1024, (context, size) => {
	const boards = 16;
	const boardHeight = size / boards;

	for (let i = 0; i < boards; i++) {
		const shade = 168 + Math.random() * 7;

		context.fillStyle = `rgb(${shade} ${shade - 2} ${shade - 7})`;
		context.fillRect(0, i * boardHeight, size, boardHeight);
		context.fillStyle = 'rgb(60 58 54 / 0.2)';
		context.fillRect(0, i * boardHeight, size, 1);
	}

	speckle(context, size, 26000, 0.07);
});

// Large stone slabs for the deck
const stoneTexture = createTexture(1024, (context, size) => {
	const columns = 4;
	const rows = 4;

	for (let row = 0; row < rows; row++) {
		for (let column = 0; column < columns; column++) {
			const shade = 128 + Math.random() * 16;

			context.fillStyle = `rgb(${shade} ${shade - 4} ${shade - 11})`;
			context.fillRect(column * size / columns, row * size / rows, size / columns, size / rows);
		}
	}

	context.fillStyle = 'rgb(30 28 26 / 0.65)';

	for (let i = 0; i < rows; i++) context.fillRect(0, i * size / rows, size, 3);
	for (let i = 0; i < columns; i++) context.fillRect(i * size / columns, 0, 3, size);

	speckle(context, size, 20000, 0.1);
});

// Vertical cedar planks
const woodTexture = createTexture(512, (context, size) => {
	const planks = 16;
	const plankWidth = size / planks;

	for (let i = 0; i < planks; i++) {
		const shade = Math.random() * 20;

		context.fillStyle = `rgb(${112 + shade} ${80 + shade * 0.8} ${56 + shade * 0.6})`;
		context.fillRect(i * plankWidth, 0, plankWidth, size);
		context.fillStyle = 'rgb(30 16 8 / 0.5)';
		context.fillRect(i * plankWidth, 0, 1.5, size);
	}

	for (let i = 0; i < 700; i++) {
		context.fillStyle = `rgb(40 20 10 / ${Math.random() * 0.1})`;
		context.fillRect(Math.random() * size, Math.random() * size, 1, 12 + Math.random() * 70);
	}
});

const groundTexture = createTexture(512, (context, size) => {
	context.fillStyle = '#ffffff';
	context.fillRect(0, 0, size, size);
	speckle(context, size, 42000, 0.2);
});
groundTexture.repeat.set(70, 70);

const concrete = new THREE.MeshStandardMaterial({ map: concreteTexture, roughness: 0.84 });
const stone = new THREE.MeshStandardMaterial({ map: stoneTexture, roughness: 0.72 });
const cedar = new THREE.MeshStandardMaterial({ map: woodTexture, roughness: 0.62 });
const blackSteel = new THREE.MeshStandardMaterial({ color: 0x17171a, roughness: 0.4, metalness: 0.8 });
const fabric = new THREE.MeshStandardMaterial({ color: 0x54503f, roughness: 0.95 });

const glass = new THREE.MeshStandardMaterial({
	color: 0x5f7078, // dark enough to keep the sun's highlight from flaring in the bloom
	roughness: 0.22,
	metalness: 0.95,
	transparent: true,
	opacity: 0.26,
	depthWrite: false,
	envMapIntensity: 3.2
});

// 6. Create the landscape
const noise = new ImprovedNoise();

function terrainNoise(x, z) {
	return noise.noise(x * 0.011, z * 0.011, 1.3)
		+ noise.noise(x * 0.034, z * 0.034, 4.1) * 0.4
		+ noise.noise(x * 0.09, z * 0.09, 7.7) * 0.12;
}

// The site is flat around the house and rises into hills further away
function groundHeight(x, z) {
	const distance = Math.hypot(x, z * 0.85);
	const rise = THREE.MathUtils.smoothstep(distance, 34, 140);

	return -0.03 + rise * rise * Math.max(7 + terrainNoise(x, z) * 16, -1);
}

function createTerrain() {
	const geometry = new THREE.PlaneGeometry(640, 640, 220, 220);
	geometry.rotateX(-Math.PI / 2);

	const position = geometry.attributes.position;
	const colors = new Float32Array(position.count * 3);
	const dryGrass = new THREE.Color(0x7d7a45);
	const greenGrass = new THREE.Color(0x46552c);
	const color = new THREE.Color();

	for (let i = 0; i < position.count; i++) {
		const x = position.getX(i);
		const z = position.getZ(i);
		const mix = THREE.MathUtils.clamp(noise.noise(x * 0.05, z * 0.05, 3.3) * 1.5 + 0.5, 0, 1);

		position.setY(i, groundHeight(x, z));
		color.lerpColors(dryGrass, greenGrass, mix).toArray(colors, i * 3);
	}

	geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
	geometry.computeVertexNormals();

	const terrain = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
		map: groundTexture,
		vertexColors: true,
		roughness: 1
	}));
	terrain.receiveShadow = true;

	return terrain;
}

// A ring of far mountains that the fog turns into layered silhouettes
function createMountains() {
	const inner = 340;
	const outer = 600;
	const geometry = new THREE.RingGeometry(inner, outer, 260, 10);
	geometry.rotateX(-Math.PI / 2);

	const position = geometry.attributes.position;

	for (let i = 0; i < position.count; i++) {
		const x = position.getX(i);
		const z = position.getZ(i);
		const edge = Math.sin((Math.hypot(x, z) - inner) / (outer - inner) * Math.PI);
		const ridge = 1 - Math.abs(noise.noise(x * 0.0065, z * 0.0065, 11.5) * 2);

		position.setY(i, edge * (8 + ridge * ridge * 54) + noise.noise(x * 0.03, z * 0.03, 2.2) * 3);
	}

	geometry.computeVertexNormals();

	return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
		color: 0x47505c,
		roughness: 1
	}));
}

scene.add(createTerrain(), createMountains());

// 7. Build the house
const house = new THREE.Group();
scene.add(house);

// Scales the UVs of a box so that textures keep the same size on every face
function scaleBoxUvs(geometry, width, height, depth) {
	const faces = [
		[depth, height], [depth, height],
		[width, depth], [width, depth],
		[width, height], [width, height]
	];
	const uv = geometry.attributes.uv;

	for (let i = 0; i < uv.count; i++) {
		const [u, v] = faces[Math.floor(i / 4)];

		uv.setXY(i, uv.getX(i) * u / TEXTURE_METERS, uv.getY(i) * v / TEXTURE_METERS);
	}
}

// Adds a box described by its [min, max] range on each axis
function box(x, y, z, material, { cast = true, parent = house } = {}) {
	const width = x[1] - x[0];
	const height = y[1] - y[0];
	const depth = z[1] - z[0];
	const geometry = new THREE.BoxGeometry(width, height, depth);
	scaleBoxUvs(geometry, width, height, depth);

	const mesh = new THREE.Mesh(geometry, material);
	mesh.position.set((x[0] + x[1]) / 2, (y[0] + y[1]) / 2, (z[0] + z[1]) / 2);
	mesh.castShadow = cast && material !== glass;
	mesh.receiveShadow = material !== glass;
	parent.add(mesh);

	return mesh;
}

// Each room lights up at its own moment of the sunset
const rooms = [];

function createRoom(lightOnAt, lightPositions) {
	const room = {
		lightOnAt,
		wall: new THREE.MeshStandardMaterial({
			map: woodTexture,
			emissive: 0xffa55e,
			emissiveMap: woodTexture,
			roughness: 0.6
		}),
		lamp: new THREE.MeshStandardMaterial({ color: 0x1a1816, emissive: 0xffc98f }),
		lights: lightPositions.map((position) => {
			const light = new THREE.PointLight(0xffb070, 0, 20, 1.7);

			light.position.set(...position);
			house.add(light);

			return light;
		})
	};

	rooms.push(room);

	return room;
}

function addMullions(xStart, xEnd, step, y, z) {
	for (let x = xStart; x <= xEnd + 0.01; x += step) {
		box([x - 0.03, x + 0.03], y, [z - 0.05, z + 0.05], blackSteel);
	}
}

// Deck around the pool (the opening is x -6 to 12, z 8.5 to 13.5)
box([-18, 18], [0, 0.4], [-8, 8.5], stone);
box([-18, 18], [0, 0.4], [13.5, 15], stone);
box([-18, -6], [0, 0.4], [8.5, 13.5], stone);
box([12, 18], [0, 0.4], [8.5, 13.5], stone);
box([-6, 12], [0, 0.05], [8.5, 13.5], blackSteel, { cast: false });

for (let i = 0; i < 3; i++) {
	box([-3, 3], [0, 0.3 - i * 0.1], [15 + i * 0.45, 15.45 + i * 0.45], stone);
}

// Ground floor: an open, fully glazed living space
const groundRoom = createRoom(0.42, [[-4, 2.9, 0.5], [4, 2.9, 0.5]]);

box([-9, 9], [0.4, 0.5], [-5, 4], cedar);
box([-9.4, 9.4], [3.6, 3.9], [-5.5, 4.6], concrete);
box([-9.4, 9.4], [0.4, 3.6], [-5.5, -5.2], concrete);
box([-9, 9], [0.5, 3.6], [-5.2, -5], groundRoom.wall, { cast: false });
box([-9.4, -9], [0.4, 3.6], [-5.2, 4.6], concrete);
box([9, 9.4], [0.4, 3.6], [-5.2, 0], concrete);
box([-9, 9], [0.5, 3.6], [3.96, 4.04], glass);
box([8.96, 9.04], [0.5, 3.6], [0, 4], glass);
addMullions(-9, 9, 3, [0.5, 3.6], 4);

for (let x = -7; x <= 7; x += 3.5) {
	box([x - 1.2, x + 1.2], [3.55, 3.6], [0.2, 0.5], groundRoom.lamp, { cast: false });
}

box([-5, -1], [0.5, 0.95], [-2.2, -1.2], fabric);
box([-5, -1], [0.95, 1.35], [-2.5, -2.2], fabric);
box([-4, -2], [0.5, 0.82], [-0.5, 0.6], blackSteel);
box([2.5, 6.8], [0.5, 1.45], [-2.6, -1.5], concrete);

// Upper floor: a long volume cantilevered over the terrace and to the side
const upperRoom = createRoom(0.52, [[-8, 6.6, 1], [0, 6.6, 1]]);

box([-14, 6], [3.9, 4.2], [-4, 7.5], concrete);
box([-14, 6], [7.1, 7.5], [-4, 7.5], concrete);
box([-14, 6], [4.2, 7.1], [-4, -3.7], concrete);
box([-13.9, 5.9], [4.2, 7.1], [-3.7, -3.5], upperRoom.wall, { cast: false });
box([-14, -13.6], [4.2, 7.1], [-3.5, 7.5], concrete);
box([5.6, 6], [4.2, 7.1], [-3.5, 7.5], concrete);
box([-13.6, 5.6], [4.2, 4.28], [-3.5, 6.7], cedar);
box([-13.6, 5.6], [4.28, 7.1], [6.66, 6.74], glass);
addMullions(-13.6, 5.6, 3.2, [4.28, 7.1], 6.7);

for (let x = -11; x <= 3; x += 3.5) {
	box([x - 1.2, x + 1.2], [7.05, 7.1], [1.4, 1.7], upperRoom.lamp, { cast: false });
}

box([-11, -7.4], [4.28, 4.85], [-2.6, -0.6], fabric);
box([-1, 3], [4.28, 5.05], [-3.5, -2.8], blackSteel);

// Slender steel columns carry the front of the cantilever
for (const x of [-5.4, 1.6]) {
	box([x - 0.07, x + 0.07], [0.4, 3.9], [6.9, 7.04], blackSteel);
}

// Cedar fins shade the left part of the upper facade
const finGeometry = new THREE.BoxGeometry(0.07, 2.84, 0.28);
const finCount = 22;
const fins = new THREE.InstancedMesh(finGeometry, cedar, finCount);
const dummy = new THREE.Object3D();

for (let i = 0; i < finCount; i++) {
	dummy.position.set(-13.2 + i * 0.5, 5.69, 7.25);
	dummy.updateMatrix();
	fins.setMatrixAt(i, dummy.matrix);
}

fins.castShadow = true;
house.add(fins);

// Top floor: a small, closed volume with a band window
const topRoom = createRoom(0.62, [[3.2, 9.6, 5.2]]);

box([-1, 7.5], [7.5, 8.45], [-3, 3.5], concrete);
box([-1, 7.5], [9.55, 10.4], [-3, 3.5], concrete);
box([-1, -0.6], [8.45, 9.55], [-3, 3.5], concrete);
box([7.1, 7.5], [8.45, 9.55], [-3, 3.5], concrete);
box([-0.6, 7.1], [8.45, 9.55], [-3, -2.6], concrete);
box([-0.6, 7.1], [8.45, 9.55], [-2.6, -2.4], topRoom.wall, { cast: false });
box([-0.6, 7.1], [8.45, 9.55], [3.26, 3.34], glass);
addMullions(-0.6, 7.1, 1.925, [8.45, 9.55], 3.3);
box([-1.5, 8], [10.4, 10.62], [-3.5, 4], concrete);

// A concrete blade wall anchors the house in the garden
box([9.4, 24], [0, 3.1], [-1, -0.6], concrete);
box([-24, -14], [0, 2.3], [-3, -2.6], concrete);

// Stone path and bollards leading to the steps
const bollardMaterial = new THREE.MeshStandardMaterial({ color: 0x1b1a18, emissive: 0xffc58a });

for (let z = 17.4; z < 62; z += 1.9) {
	const y = groundHeight(0, z);

	box([-1.6, 1.6], [y - 0.1, y + 0.05], [z, z + 1.45], stone, { cast: false });
}

for (let z = 22; z < 62; z += 8) {
	for (const x of [-2.4, 2.4]) {
		const y = groundHeight(x, z);

		box([x - 0.05, x + 0.05], [y, y + 0.55], [z - 0.05, z + 0.05], blackSteel);
		box([x - 0.05, x + 0.05], [y + 0.55, y + 0.68], [z - 0.05, z + 0.05], bollardMaterial, { cast: false });
	}
}

// 8. Create the pool
const poolShader = {
	name: 'PoolShader',
	uniforms: {
		color: { value: null },
		tDiffuse: { value: null },
		textureMatrix: { value: null },
		time: { value: 0 },
		glow: { value: 0 }
	},
	vertexShader: /* glsl */`
		uniform mat4 textureMatrix;
		varying vec4 vReflection;
		varying vec2 vPosition;

		void main() {
			vReflection = textureMatrix * vec4(position, 1.0);
			vPosition = position.xy;
			gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
		}
	`,
	fragmentShader: /* glsl */`
		uniform vec3 color;
		uniform sampler2D tDiffuse;
		uniform float time;
		uniform float glow;
		varying vec4 vReflection;
		varying vec2 vPosition;

		void main() {
			// Slow ripples bend the reflection
			vec2 ripple = vec2(
				sin(vPosition.x * 1.3 + time * 0.5) + sin(vPosition.y * 2.9 - time * 0.4),
				cos(vPosition.y * 2.4 + time * 0.45) + sin(vPosition.x * 1.9 + time * 0.3)
			) * 0.0008;

			vec4 coordinates = vReflection;
			coordinates.xy += ripple * coordinates.w;

			vec3 reflection = texture2DProj(tDiffuse, coordinates).rgb;
			vec3 underwater = vec3(0.1, 0.62, 0.68);

			gl_FragColor = vec4(reflection * color + underwater * glow, 1.0);

			#include <tonemapping_fragment>
			#include <colorspace_fragment>
		}
	`
};

const pool = new Reflector(new THREE.PlaneGeometry(18, 5), {
	clipBias: 0.002,
	color: 0xc8dade,
	multisample: 4,
	shader: poolShader,
	textureHeight: 512,
	textureWidth: 1024
});

pool.rotation.x = -Math.PI / 2;
pool.position.set(3, 0.3, 11);
scene.add(pool);

// 9. Plant the vegetation
const random = THREE.MathUtils.seededRandom;
random(2024);

function nearCameraPath(x, z) {
	return z > 6 && Math.hypot(x, z) < 105;
}

function scatter(count, minDistance, maxDistance) {
	const points = [];

	while (points.length < count) {
		const angle = random() * Math.PI * 2;
		const distance = minDistance + random() * (maxDistance - minDistance);
		const x = Math.cos(angle) * distance;
		const z = Math.sin(angle) * distance;

		if (!nearCameraPath(x, z)) points.push([x, z]);
	}

	return points;
}

function setInstance(mesh, index, x, y, z, scaleX, scaleY, scaleZ, rotation, color) {
	dummy.position.set(x, y, z);
	dummy.rotation.set(0, rotation, 0);
	dummy.scale.set(scaleX, scaleY, scaleZ);
	dummy.updateMatrix();
	mesh.setMatrixAt(index, dummy.matrix);
	mesh.setColorAt(index, color);
}

// Tall cypresses form a dark line behind the house
function createCypresses() {
	const points = [...scatter(70, 30, 170)];

	for (let x = -30; x <= 32; x += 3.4 + random() * 2.6) {
		points.push([x, -13 - random() * 7]);
	}

	points.push([-20, 1], [-22.5, 3.5], [24, 4], [27, 1.5]);

	// A flame-shaped profile with some lumps of foliage
	const profile = [];

	for (let i = 0; i <= 14; i++) {
		const t = i / 14;

		profile.push(new THREE.Vector2(Math.sin(Math.PI * t ** 0.62) ** 0.85 * 0.8 + 0.001, t));
	}

	const geometry = new THREE.LatheGeometry(profile, 14);
	const shape = geometry.attributes.position;

	for (let i = 0; i < shape.count; i++) {
		const lump = 1 + noise.noise(shape.getX(i) * 3, shape.getY(i) * 9, shape.getZ(i) * 3) * 0.3;

		shape.setXYZ(i, shape.getX(i) * lump, shape.getY(i), shape.getZ(i) * lump);
	}

	geometry.computeVertexNormals();

	const material = new THREE.MeshStandardMaterial({ roughness: 0.95 });
	const mesh = new THREE.InstancedMesh(geometry, material, points.length);
	const color = new THREE.Color();

	points.forEach(([x, z], index) => {
		const height = 8 + random() * 7;
		const radius = 0.85 + random() * 0.55;

		color.setHSL(0.3 + random() * 0.05, 0.34, 0.08 + random() * 0.04);
		setInstance(mesh, index, x, groundHeight(x, z) - 0.1, z, radius, height, radius, random() * 6, color);
	});

	mesh.castShadow = true;
	mesh.receiveShadow = true;

	return mesh;
}

// Rounded trees: a trunk and a few overlapping crowns
function createRoundTrees() {
	const trees = [
		...scatter(55, 30, 190),
		[-24, 7, 1.15], [-36, 10, 1.3], [30, 2, 1.2], [40, 8, 1.35], [-19, -9, 1.1], [22, -8, 1.25]
	];
	const crownsPerTree = 6;

	const crownGeometry = mergeVertices(new THREE.IcosahedronGeometry(1, 5).deleteAttribute('normal').deleteAttribute('uv'));
	const crownPosition = crownGeometry.attributes.position;

	for (let i = 0; i < crownPosition.count; i++) {
		const x = crownPosition.getX(i);
		const y = crownPosition.getY(i);
		const z = crownPosition.getZ(i);
		const bump = 1 + noise.noise(x * 3.2, y * 3.2, z * 3.2) * 0.42 + noise.noise(x * 8, y * 8, z * 8) * 0.14;

		crownPosition.setXYZ(i, x * bump, y * bump, z * bump);
	}

	crownGeometry.computeVertexNormals();

	const crowns = new THREE.InstancedMesh(
		crownGeometry,
		new THREE.MeshStandardMaterial({ roughness: 0.95 }),
		trees.length * crownsPerTree
	);
	const trunks = new THREE.InstancedMesh(
		new THREE.CylinderGeometry(0.12, 0.2, 1, 7),
		new THREE.MeshStandardMaterial({ color: 0x3a2d22, roughness: 1 }),
		trees.length
	);
	const color = new THREE.Color();

	trees.forEach(([x, z, size = 0.9 + random() * 0.8], index) => {
		const y = groundHeight(x, z);
		const trunkHeight = 2.4 * size;

		color.set(0xffffff);
		setInstance(trunks, index, x, y + trunkHeight / 2, z, size, trunkHeight, size, 0, color);

		for (let crown = 0; crown < crownsPerTree; crown++) {
			const angle = random() * Math.PI * 2;
			const spread = crown === 0 ? 0 : 1.2 * size;

			color.setHSL(0.24 + random() * 0.06, 0.3, 0.1 + random() * 0.05);
			setInstance(
				crowns,
				index * crownsPerTree + crown,
				x + Math.cos(angle) * spread,
				y + trunkHeight + (0.5 + random() * 1.1) * size,
				z + Math.sin(angle) * spread,
				(1.25 + random() * 0.6) * size,
				(0.95 + random() * 0.45) * size,
				(1.25 + random() * 0.6) * size,
				random() * 6,
				color
			);
		}
	});

	for (const mesh of [crowns, trunks]) {
		mesh.castShadow = true;
		mesh.receiveShadow = true;
	}

	return [crowns, trunks];
}

scene.add(createCypresses(), ...createRoundTrees());

// 10. Add lighting
const hemisphereLight = new THREE.HemisphereLight(0xffffff, 0x5c5244, 1);
scene.add(hemisphereLight);

const sun = new THREE.DirectionalLight(0xffffff, 1);

sun.target.position.set(0, 3, 2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -48;
sun.shadow.camera.right = 48;
sun.shadow.camera.top = 40;
sun.shadow.camera.bottom = -40;
sun.shadow.camera.near = 10;
sun.shadow.camera.far = 320;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.05;
scene.add(sun, sun.target);

// The time of day runs through three key moments: 0 day, 0.5 golden hour, 1 dusk
const PALETTE = {
	zenith: [0x4d86c4, 0x3a5a9c, 0x0c1838],
	horizon: [0xeadfca, 0xf2a873, 0x2c4a80],
	glow: [0xfff0d4, 0xff9346, 0xe0683f],
	sunLight: [0xfff0da, 0xffa862, 0xff7044],
	hemisphereSky: [0xcfdcf5, 0xb4bcd6, 0x4a72b8]
};

const nextStop = new THREE.Color();

function samplePalette(target, stops, dusk) {
	const position = dusk * 2;
	const index = Math.min(Math.floor(position), 1);

	return target.set(stops[index]).lerp(nextStop.set(stops[index + 1]), position - index);
}

function updateTimeOfDay(dusk) {
	const { lerp, smoothstep } = THREE.MathUtils;
	const elevation = lerp(0.52, -0.05, dusk);
	const uniforms = skyMaterial.uniforms;

	sunDirection.set(-0.82 * Math.cos(elevation), Math.sin(elevation), 0.58 * Math.cos(elevation)).normalize();

	samplePalette(uniforms.zenith.value, PALETTE.zenith, dusk);
	samplePalette(uniforms.horizon.value, PALETTE.horizon, dusk);
	samplePalette(uniforms.glow.value, PALETTE.glow, dusk);
	scene.fog.color.copy(uniforms.horizon.value);

	// The light keeps a minimum height so that it never shines from below the ground
	sun.position.copy(sun.target.position);
	sun.position.x += sunDirection.x * 150;
	sun.position.y += Math.max(sunDirection.y, 0.07) * 150;
	sun.position.z += sunDirection.z * 150;
	samplePalette(sun.color, PALETTE.sunLight, dusk);
	sun.intensity = lerp(4.6, 0.05, smoothstep(dusk, 0.45, 0.95));

	samplePalette(hemisphereLight.color, PALETTE.hemisphereSky, dusk);
	hemisphereLight.intensity = lerp(0.7, 1.05, dusk);
	scene.environmentIntensity = lerp(0.4, 0.3, dusk);

	for (const room of rooms) {
		const brightness = smoothstep(dusk, room.lightOnAt, room.lightOnAt + 0.2);

		room.wall.emissiveIntensity = brightness * 1.15;
		room.lamp.emissiveIntensity = brightness * 3.4;

		for (const light of room.lights) light.intensity = brightness * 30;
	}

	const nightfall = smoothstep(dusk, 0.66, 0.88);

	bollardMaterial.emissiveIntensity = nightfall * 9;
	pool.material.uniforms.glow.value = nightfall * 0.22;
}

// The reflections on the glass come from an environment map of the sky at golden hour
function createEnvironment() {
	const environmentScene = new THREE.Scene();
	const environmentSky = new THREE.Mesh(sky.geometry, skyMaterial);
	const generator = new THREE.PMREMGenerator(renderer);

	updateTimeOfDay(0.62);
	environmentScene.add(environmentSky);

	const { texture } = generator.fromScene(environmentScene, 0, 1, 1000);
	generator.dispose();

	return texture;
}

scene.environment = createEnvironment();

// 11. Add the dust floating in the air
function createDust() {
	const count = 420;
	const positions = new Float32Array(count * 3);

	for (let i = 0; i < count; i++) {
		positions[i * 3] = (Math.random() - 0.5) * 70;
		positions[i * 3 + 1] = Math.random() * 14;
		positions[i * 3 + 2] = Math.random() * 70 - 12;
	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

	const sprite = createTexture(32, (context, size) => {
		const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
		gradient.addColorStop(0, '#ffffff');
		gradient.addColorStop(1, '#000000');
		context.fillStyle = gradient;
		context.fillRect(0, 0, size, size);
	});
	sprite.colorSpace = THREE.NoColorSpace;

	return new THREE.Points(geometry, new THREE.PointsMaterial({
		color: 0xffd9ad,
		size: 0.09,
		alphaMap: sprite,
		transparent: true,
		opacity: 0.55,
		depthWrite: false,
		blending: THREE.AdditiveBlending
	}));
}

const dust = createDust();
scene.add(dust);

// 12. Add the post-processing
const composerTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
	type: THREE.HalfFloatType,
	samples: 4
});
const composer = new EffectComposer(renderer, composerTarget);

composer.setPixelRatio(renderer.getPixelRatio());
composer.setSize(window.innerWidth, window.innerHeight);

const gradePass = new ShaderPass({
	uniforms: {
		tDiffuse: { value: null },
		fade: { value: 0 },
		time: { value: 0 }
	},
	vertexShader: /* glsl */`
		varying vec2 vUv;

		void main() {
			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
		}
	`,
	fragmentShader: /* glsl */`
		uniform sampler2D tDiffuse;
		uniform float fade;
		uniform float time;
		varying vec2 vUv;

		void main() {
			vec3 color = clamp(texture2D(tDiffuse, vUv).rgb, 0.0, 1.0);

			// Film look: more saturation and contrast, warm highlights and cool shadows
			float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
			color = mix(vec3(luma), color, 1.16);
			color = mix(color, color * color * (3.0 - 2.0 * color), 0.35);
			color += (luma - 0.5) * vec3(0.03, 0.0, -0.035);

			float vignette = smoothstep(0.9, 0.28, length(vUv - 0.5));
			float grain = fract(sin(dot(vUv + fract(time), vec2(12.9898, 78.233))) * 43758.5453) - 0.5;

			color *= mix(0.68, 1.0, vignette);
			color += grain * 0.022;

			gl_FragColor = vec4(color * fade, 1.0);
		}
	`
});

composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.3, 0.65, 1.05));
composer.addPass(new OutputPass());
composer.addPass(gradePass);

// 13. Direct the film
const shotPosition = new THREE.Vector3();
const shotTarget = new THREE.Vector3();
const fromVector = new THREE.Vector3();
const toVector = new THREE.Vector3();
const pointer = new THREE.Vector2();
const smoothPointer = new THREE.Vector2();
const lensShift = new THREE.Vector2();

let filmTime = 0;
let paused = false;
let exploring = false;
let elapsed = 0;
let blackout = 1;
let currentDusk = 0;

function findShot(time) {
	let start = 0;

	for (let index = 0; index < SHOTS.length; index++) {
		if (time < start + SHOTS[index].duration) return { index, start };

		start += SHOTS[index].duration;
	}

	return { index: SHOTS.length - 1, start: start - SHOTS.at(-1).duration };
}

function filmDusk(time) {
	return THREE.MathUtils.lerp(0.3, 1, time / FILM_DURATION);
}

// Narrow screens need a wider lens to keep the house in frame
function adaptFov(fov) {
	return fov * THREE.MathUtils.clamp(1.6 / camera.aspect, 1, 1.9);
}

// Slides the frame over the image plane, which also updates the projection matrix
function applyLensShift() {
	const width = window.innerWidth;
	const height = window.innerHeight;

	camera.setViewOffset(width, height, -lensShift.x * width, -lensShift.y * height, width, height);
}

function poseCamera(time) {
	const { index, start } = findShot(time);
	const shot = SHOTS[index];
	const local = time - start;
	const progress = local / shot.duration;

	// Mostly linear, with a soft start and end like a camera on a dolly
	const eased = THREE.MathUtils.lerp(progress, THREE.MathUtils.smootherstep(progress, 0, 1), 0.45);

	shotPosition.lerpVectors(fromVector.set(...shot.from.position), toVector.set(...shot.to.position), eased);
	shotTarget.lerpVectors(fromVector.set(...shot.from.target), toVector.set(...shot.to.target), eased);

	camera.position.copy(shotPosition);
	camera.lookAt(shotTarget);

	// A faint sway and the pointer give the frame some life
	camera.translateX(smoothPointer.x * 0.45 + Math.sin(elapsed * 0.31) * 0.05);
	camera.translateY(smoothPointer.y * 0.2 + Math.sin(elapsed * 0.43) * 0.035);
	camera.rotateZ(Math.sin(elapsed * 0.23) * 0.0025);

	camera.fov = adaptFov(THREE.MathUtils.lerp(shot.fov[0], shot.fov[1], eased));

	// On narrow screens the copy fills the bottom of the frame: the house moves up instead of aside
	const isWide = camera.aspect > 1.2;
	const shiftY = THREE.MathUtils.lerp(shot.shiftY[0], shot.shiftY[1], eased);

	lensShift.set(isWide ? LENS_SHIFT_X : 0, isWide ? shiftY : shiftY - 0.3);

	const edge = Math.min(local, shot.duration - local) / FADE_DURATION;

	return { index, progress, fade: THREE.MathUtils.smoothstep(edge, 0, 1) };
}

// 14. Connect the hero interface
const exploreButton = document.querySelector('#explore');
const pauseButton = document.querySelector('#pause');
const backButton = document.querySelector('#back-to-film');
const heroSection = document.querySelector('#hero');
const explorePanel = document.querySelector('#explore-panel');
const chaptersBar = document.querySelector('#chapters');
const chapterButtons = [...document.querySelectorAll('.chapter')];

let activeChapter = -1;

function setPaused(value) {
	paused = value;
	pauseButton.textContent = paused ? 'Play' : 'Pause';
}

function jumpToShot(index) {
	filmTime = SHOTS.slice(0, index).reduce((total, shot) => total + shot.duration, 0) + FADE_DURATION;
	blackout = 0;
}

function setExploring(value) {
	exploring = value;
	document.body.classList.toggle('is-exploring', exploring);
	heroSection.inert = exploring;
	chaptersBar.inert = exploring;
	explorePanel.inert = !exploring;
	controls.enabled = exploring;
	pressedKeys.clear();
	blackout = 0;

	if (exploring) {
		camera.position.set(...EXPLORE_VIEW.position);
		controls.target.set(...EXPLORE_VIEW.target);
		camera.fov = adaptFov(EXPLORE_VIEW.fov);
		lensShift.set(0, 0);
		controls.update();
		backButton.focus();
	} else {
		exploreButton.focus();
	}
}

exploreButton.addEventListener('click', () => setExploring(true));
backButton.addEventListener('click', () => setExploring(false));
pauseButton.addEventListener('click', () => setPaused(!paused));

for (const button of chapterButtons) {
	button.addEventListener('click', () => jumpToShot(Number(button.dataset.shot)));
}

function updateChapters(index, progress) {
	if (index !== activeChapter) {
		chapterButtons.forEach((button, buttonIndex) => {
			button.setAttribute('aria-current', buttonIndex === index);
			button.style.setProperty('--progress', buttonIndex < index ? 1 : 0);
		});

		activeChapter = index;
	}

	chapterButtons[index].style.setProperty('--progress', progress.toFixed(3));
}

window.addEventListener('pointermove', (event) => {
	if (prefersReducedMotion || event.pointerType !== 'mouse') return;

	pointer.set(event.clientX / window.innerWidth * 2 - 1, 1 - event.clientY / window.innerHeight * 2);
});

// 15. Add camera control
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enabled = false;
controls.minDistance = 6;
controls.maxDistance = 110;
controls.maxPolarAngle = Math.PI * 0.56;

const pressedKeys = new Set();
const offset = new THREE.Vector3();
const spherical = new THREE.Spherical();

window.addEventListener('keydown', (event) => {
	if (!exploring || event.altKey || event.ctrlKey || event.metaKey) return;

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

// 16. AnimationLoop
let previousTime = performance.now();
let lastFade = 0;
let frameCount = 0;

renderer.shadowMap.autoUpdate = false;

function animate(time) {
	const delta = THREE.MathUtils.clamp((time - previousTime) / 1000, 0, 0.1);
	previousTime = time;

	const moving = exploring || !paused;

	if (moving) elapsed += delta;

	blackout = Math.min(blackout + delta / FADE_DURATION, 1);

	if (exploring) {
		updateKeyboardControls(delta);
		controls.update();

		const floor = groundHeight(camera.position.x, camera.position.z) + 0.8;

		camera.position.y = Math.max(camera.position.y, floor);
		currentDusk = THREE.MathUtils.damp(currentDusk, EXPLORE_DUSK, 1.1, delta);
		lastFade = 1;
	} else {
		if (!paused) filmTime = (filmTime + delta) % FILM_DURATION;

		smoothPointer.x = THREE.MathUtils.damp(smoothPointer.x, pointer.x, 2.5, delta);
		smoothPointer.y = THREE.MathUtils.damp(smoothPointer.y, pointer.y, 2.5, delta);

		const { index, progress, fade } = poseCamera(filmTime);

		updateChapters(index, progress);
		currentDusk = filmDusk(filmTime);
		lastFade = fade;
	}

	applyLensShift();
	updateTimeOfDay(currentDusk);

	// The sun moves slowly enough to refresh the shadows every third frame
	frameCount++;
	renderer.shadowMap.needsUpdate = frameCount % 3 === 0;

	sky.position.copy(camera.position);
	pool.material.uniforms.time.value = elapsed;
	dust.rotation.y = elapsed * 0.006;
	dust.position.y = Math.sin(elapsed * 0.12) * 0.4;

	gradePass.uniforms.fade.value = Math.min(lastFade, THREE.MathUtils.smoothstep(blackout, 0, 1));
	gradePass.uniforms.time.value = elapsed;

	composer.render(delta);
}

if (prefersReducedMotion) {
	filmTime = FILM_DURATION - SHOTS.at(-1).duration / 2;
	setPaused(true);
}

renderer.setAnimationLoop(animate);

// 17. Handle browser resizing
window.addEventListener('resize', () => {
	camera.aspect = window.innerWidth / window.innerHeight;

	if (exploring) camera.fov = adaptFov(EXPLORE_VIEW.fov);

	renderer.setSize(window.innerWidth, window.innerHeight);
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
	composer.setPixelRatio(renderer.getPixelRatio());
	composer.setSize(window.innerWidth, window.innerHeight);
});

// Lets a local capture script freeze any moment of the film
if (import.meta.env.DEV) {
	window.seekFilm = (time) => {
		filmTime = time;
		blackout = 1;
		setPaused(true);
	};
}
