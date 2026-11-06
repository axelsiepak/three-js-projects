import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import './style.css';

// Slice shape
const RADIUS = 2;
const HALF_ANGLE = THREE.MathUtils.degToRad(44);
const THICKNESS = 0.85;
const ROUNDING = 0.12;
const SURFACE_CELL = 0.055; // resolution of the rendered surface
const LATTICE_CELL = 0.27; // resolution of the physical tetrahedra
const CAP_EDGE = 0.2; // longest edge allowed on a cut face
const SEED_COUNT = 16;

// Jelly material
const DENSITY = 1;
const SHEAR_MODULUS = 260; // softness of the flesh
const RIND_STIFFNESS = 2.2; // the rind is firmer than the flesh
const BULK_RATIO = 11; // how strongly the jelly keeps its volume
const VISCOSITY = 0.006; // how quickly the wobble fades, in seconds

// Simulation
const GRAVITY = 16;
const SUBSTEP = 1 / 360;
const MAX_FRAME_TIME = 1 / 30;
const MAX_SPEED = 22;
const GROUND_FRICTION = 0.9;
const JELLY_FRICTION = 0.3;
const CONTACT_MARGIN = 0.012;

// Cutting
const MIN_PIECE_VOLUME = 0.02;
const MIN_PIECE_THICKNESS = 0.16; // thinner pieces can't be simulated by the lattice
const MAX_PIECES = 28;
const SPLIT_IMPULSE = 0.45;
const MIN_CUT_PIXELS = 20;
const STROKE_SAMPLE_PIXELS = 10;
const CLICK_PIXELS = 6;

// 1. Create the scene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);

// 2. Create the camera
const camera = new THREE.PerspectiveCamera(
	36,
	window.innerWidth / window.innerHeight,
	0.1,
	100
);

camera.position.set(2.3, 2.5, 6.9);

// 3. Create the renderer
const renderer = new THREE.WebGLRenderer({
	antialias: true
});

renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap;

document.body.appendChild(renderer.domElement);

// 4. Add lighting and the invisible floor that only shows shadows
// Reflections come from a white studio, to match the white background
function createStudioEnvironment() {
	const studio = new THREE.Scene();
	const panelGeometry = new THREE.PlaneGeometry(1, 1);

	studio.add(new THREE.Mesh(
		new THREE.BoxGeometry(20, 20, 20),
		new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.BackSide })
	));

	const panels = [
		{ brightness: 7, size: [9, 6], position: [0, 9.5, 2] }, // main softbox above
		{ brightness: 5, size: [2.5, 8], position: [-9, 3, 5] }, // window on the left
		{ brightness: 3, size: [2, 6], position: [9, 2, 6] }, // window on the right
		{ brightness: 0.45, size: [20, 20], position: [0, -9.9, 0] }, // darker floor
		{ brightness: 0.15, size: [1.4, 9], position: [4, 2, 9.5] }, // dark stripes for the steel
		{ brightness: 0.15, size: [1.4, 9], position: [-5, 2, -9.5] }
	];

	for (const { brightness, size, position } of panels) {
		const panel = new THREE.Mesh(
			panelGeometry,
			new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(brightness), side: THREE.DoubleSide })
		);

		panel.scale.set(size[0], size[1], 1);
		panel.position.set(position[0], position[1], position[2]);
		panel.lookAt(0, 0, 0);
		studio.add(panel);
	}

	const pmrem = new THREE.PMREMGenerator(renderer);
	const texture = pmrem.fromScene(studio, 0.02).texture;

	pmrem.dispose();

	return texture;
}

scene.environment = createStudioEnvironment();
scene.environmentIntensity = 0.62;

const sunLight = new THREE.DirectionalLight(0xffffff, 2);

sunLight.position.set(2.5, 8, 4);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
sunLight.shadow.camera.left = -10;
sunLight.shadow.camera.right = 10;
sunLight.shadow.camera.top = 10;
sunLight.shadow.camera.bottom = -10;
sunLight.shadow.camera.far = 24;
sunLight.shadow.radius = 7;
sunLight.shadow.blurSamples = 20;
scene.add(sunLight);

// The shadow is tinted because light passing through the jelly picks up its color
// The floor stays inside the area covered by the shadow map
const floor = new THREE.Mesh(
	new THREE.CircleGeometry(9, 64),
	new THREE.ShadowMaterial({ color: 0x5a1a24, opacity: 0.28 })
);

floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// 5. Describe the slice as a signed distance field
// Rest space: the tip is at the origin and the rind is RADIUS below it
const pieRadius = RADIUS - ROUNDING;
const pieSin = Math.sin(HALF_ANGLE);
const pieCos = Math.cos(HALF_ANGLE);
const halfDepth = THICKNESS / 2 - ROUNDING;

function sliceDistance(x, y, z) {
	const px = Math.abs(x);
	const py = -y;
	const toArc = Math.hypot(px, py) - pieRadius;
	const along = THREE.MathUtils.clamp(px * pieSin + py * pieCos, 0, pieRadius);
	const toSide = Math.hypot(px - pieSin * along, py - pieCos * along);
	const side = pieCos * px - pieSin * py > 0 ? toSide : -toSide;
	const flat = Math.max(toArc, side);
	const deep = Math.abs(z) - halfDepth;

	return Math.min(Math.max(flat, deep), 0) + Math.hypot(Math.max(flat, 0), Math.max(deep, 0)) - ROUNDING;
}

function projectOnSlice(point) {
	const e = 1e-3;

	for (let iteration = 0; iteration < 3; iteration++) {
		const [x, y, z] = point;
		const distance = sliceDistance(x, y, z);
		const gx = sliceDistance(x + e, y, z) - sliceDistance(x - e, y, z);
		const gy = sliceDistance(x, y + e, z) - sliceDistance(x, y - e, z);
		const gz = sliceDistance(x, y, z + e) - sliceDistance(x, y, z - e);
		const length = Math.hypot(gx, gy, gz) || 1;

		point[0] -= distance * gx / length;
		point[1] -= distance * gy / length;
		point[2] -= distance * gz / length;
	}

	return point;
}

// 6. Build the rendered surfaces: a mesh is { rest, index, weld }
// `weld` gives the same id to vertices sharing a position, across hard edges
function buildSliceSurface() {
	const cell = SURFACE_CELL;
	const margin = 2 * cell;
	const min = [-RADIUS * pieSin - margin, -RADIUS - margin, -THICKNESS / 2 - margin];
	const size = [
		Math.ceil((2 * RADIUS * pieSin + 2 * margin) / cell),
		Math.ceil((RADIUS + ROUNDING + 2 * margin) / cell),
		Math.ceil((THICKNESS + 2 * margin) / cell)
	];
	const stride = [1, size[0] + 1, (size[0] + 1) * (size[1] + 1)];
	const values = new Float64Array((size[0] + 1) * (size[1] + 1) * (size[2] + 1));

	for (let k = 0; k <= size[2]; k++) {
		for (let j = 0; j <= size[1]; j++) {
			for (let i = 0; i <= size[0]; i++) {
				values[i + j * stride[1] + k * stride[2]] = sliceDistance(
					min[0] + i * cell,
					min[1] + j * cell,
					min[2] + k * cell
				);
			}
		}
	}

	// Surface nets: one vertex per grid cell crossed by the surface
	const cellVertex = new Map();
	const rest = [];

	for (let k = 0; k < size[2]; k++) {
		for (let j = 0; j < size[1]; j++) {
			for (let i = 0; i < size[0]; i++) {
				const base = i + j * stride[1] + k * stride[2];
				let inside = 0;

				for (let corner = 0; corner < 8; corner++) {
					const id = base + (corner & 1) * stride[0] + ((corner >> 1) & 1) * stride[1] + ((corner >> 2) & 1) * stride[2];

					if (values[id] < 0) inside++;
				}

				if (inside === 0 || inside === 8) continue;

				const point = projectOnSlice([
					min[0] + (i + 0.5) * cell,
					min[1] + (j + 0.5) * cell,
					min[2] + (k + 0.5) * cell
				]);

				cellVertex.set(base, rest.length / 3);
				rest.push(point[0], point[1], point[2]);
			}
		}
	}

	const index = [];

	for (let k = 1; k < size[2]; k++) {
		for (let j = 1; j < size[1]; j++) {
			for (let i = 1; i < size[0]; i++) {
				const base = i + j * stride[1] + k * stride[2];

				for (let axis = 0; axis < 3; axis++) {
					const start = values[base];
					const end = values[base + stride[axis]];

					if ((start < 0) === (end < 0)) continue;

					const u = stride[(axis + 1) % 3];
					const v = stride[(axis + 2) % 3];
					const a = cellVertex.get(base - u - v);
					const b = cellVertex.get(base - v);
					const c = cellVertex.get(base);
					const d = cellVertex.get(base - u);

					if (start < 0) {
						index.push(a, b, c, a, c, d);
					} else {
						index.push(a, c, b, a, d, c);
					}
				}
			}
		}
	}

	relaxSurface(rest, index);

	return { rest, index, weld: Array.from({ length: rest.length / 3 }, (_, i) => i) };
}

// The grid leaves stairs along diagonal edges: moving each vertex to the middle
// of its neighbors, then back onto the shape, evens out the triangles
function relaxSurface(rest, index) {
	const neighbors = Array.from({ length: rest.length / 3 }, () => new Set());

	for (let t = 0; t < index.length; t += 3) {
		for (let e = 0; e < 3; e++) {
			neighbors[index[t + e]].add(index[t + (e + 1) % 3]);
			neighbors[index[t + (e + 1) % 3]].add(index[t + e]);
		}
	}

	for (let iteration = 0; iteration < 6; iteration++) {
		const smoothed = neighbors.map((around) => {
			const point = [0, 0, 0];

			for (const other of around) {
				point[0] += rest[other * 3];
				point[1] += rest[other * 3 + 1];
				point[2] += rest[other * 3 + 2];
			}

			return projectOnSlice(point.map((value) => value / around.size));
		});

		smoothed.forEach((point, i) => {
			rest[i * 3] = point[0];
			rest[i * 3 + 1] = point[1];
			rest[i * 3 + 2] = point[2];
		});
	}
}

function createRandom(seed) {
	let state = seed;

	return () => {
		state = (state + 0x6d2b79f5) | 0;

		let t = Math.imul(state ^ (state >>> 15), 1 | state);

		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function buildSeedSurface() {
	const sphere = new THREE.IcosahedronGeometry(1, 1);

	sphere.deleteAttribute('normal');
	sphere.deleteAttribute('uv');

	const shape = mergeVertices(sphere);
	const positions = shape.attributes.position;
	const random = createRandom(11);
	const centers = [];
	const rest = [];
	const index = [];

	for (let attempt = 0; attempt < 600 && centers.length < SEED_COUNT; attempt++) {
		const angle = (random() * 2 - 1) * (HALF_ANGLE - 0.1);
		const radius = RADIUS * (0.34 + random() * 0.42);
		const x = Math.sin(angle) * radius;
		const y = -Math.cos(angle) * radius;
		const z = (random() * 2 - 1) * (THICKNESS / 2 - 0.2);

		if (sliceDistance(x, y, z) > -0.13) continue;
		if (centers.some((c) => Math.hypot(c[0] - x, c[1] - y, c[2] - z) < 0.3)) continue;

		centers.push([x, y, z]);

		// A teardrop whose tip points toward the middle of the fruit
		const length = 0.085;
		const width = 0.05;
		const first = rest.length / 3;
		const dirX = -Math.sin(angle);
		const dirY = Math.cos(angle);
		const tilt = (random() - 0.5) * 0.5;

		for (let i = 0; i < positions.count; i++) {
			const px = positions.getX(i);
			const py = positions.getY(i);
			const pz = positions.getZ(i);
			const taper = 1 - 0.55 * (py * 0.5 + 0.5);
			const across = px * width * taper;
			const axial = py * length;
			const depth = pz * width * taper * 0.65;

			rest.push(
				x + dirX * axial + dirY * across,
				y + dirY * axial - dirX * across,
				z + depth + axial * tilt
			);
		}

		for (let i = 0; i < shape.index.count; i++) {
			index.push(first + shape.index.getX(i));
		}
	}

	sphere.dispose();
	shape.dispose();

	return { rest, index, weld: Array.from({ length: rest.length / 3 }, (_, i) => i) };
}

// 7. Fill the slice with a body-centered lattice of tetrahedra
const NOMINAL_TET_VOLUME = LATTICE_CELL ** 3 / 12;

function tetVolume(r, a, b, c, d) {
	const ax = r[b * 3] - r[a * 3];
	const ay = r[b * 3 + 1] - r[a * 3 + 1];
	const az = r[b * 3 + 2] - r[a * 3 + 2];
	const bx = r[c * 3] - r[a * 3];
	const by = r[c * 3 + 1] - r[a * 3 + 1];
	const bz = r[c * 3 + 2] - r[a * 3 + 2];
	const cx = r[d * 3] - r[a * 3];
	const cy = r[d * 3 + 1] - r[a * 3 + 1];
	const cz = r[d * 3 + 2] - r[a * 3 + 2];

	return (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
}

// Splits a flat list of tetrahedra into groups connected through shared nodes
function connectedTetGroups(tets, nodeCount) {
	const parent = new Int32Array(nodeCount).map((_, i) => i);

	function find(node) {
		while (parent[node] !== node) {
			parent[node] = parent[parent[node]];
			node = parent[node];
		}

		return node;
	}

	for (let t = 0; t < tets.length; t += 4) {
		const root = find(tets[t]);

		for (let c = 1; c < 4; c++) {
			parent[find(tets[t + c])] = root;
		}
	}

	const groups = new Map();

	for (let t = 0; t < tets.length; t += 4) {
		const root = find(tets[t]);

		if (!groups.has(root)) groups.set(root, []);

		groups.get(root).push(tets[t], tets[t + 1], tets[t + 2], tets[t + 3]);
	}

	return [...groups.values()];
}

function buildLattice() {
	const h = LATTICE_CELL;
	const iMax = Math.ceil(RADIUS * pieSin / h) + 1;
	const jMin = Math.floor(-RADIUS / h) - 1;
	const jMax = 2;
	const kMax = Math.ceil(THICKNESS / 2 / h) + 1;
	const ids = new Map();
	const points = [];

	function nodeAt(i, j, k, center) {
		const key = `${i},${j},${k},${center}`;
		let id = ids.get(key);

		if (id === undefined) {
			const shift = center ? 0.5 : 0;

			id = points.length;
			ids.set(key, id);
			points.push([(i + shift) * h, (j + shift) * h, (k + shift) * h]);
		}

		return id;
	}

	const candidates = [];
	const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

	for (let k = -kMax; k < kMax; k++) {
		for (let j = jMin; j < jMax; j++) {
			for (let i = -iMax; i < iMax; i++) {
				const low = nodeAt(i, j, k, true);

				for (let axis = 0; axis < 3; axis++) {
					const e = axes[axis];
					const u = axes[(axis + 1) % 3];
					const v = axes[(axis + 2) % 3];
					const high = nodeAt(i + e[0], j + e[1], k + e[2], true);
					const fi = i + e[0];
					const fj = j + e[1];
					const fk = k + e[2];
					const ring = [
						nodeAt(fi, fj, fk, false),
						nodeAt(fi + u[0], fj + u[1], fk + u[2], false),
						nodeAt(fi + u[0] + v[0], fj + u[1] + v[1], fk + u[2] + v[2], false),
						nodeAt(fi + v[0], fj + v[1], fk + v[2], false)
					];

					for (let side = 0; side < 4; side++) {
						candidates.push([low, high, ring[side], ring[(side + 1) % 4]]);
					}
				}
			}
		}
	}

	const distances = points.map(([x, y, z]) => sliceDistance(x, y, z));
	const kept = candidates.filter((tet) => {
		const center = [0, 1, 2].map((c) => (points[tet[0]][c] + points[tet[1]][c] + points[tet[2]][c] + points[tet[3]][c]) / 4);

		return tet.some((node) => distances[node] < 0) && sliceDistance(center[0], center[1], center[2]) < h * 0.35;
	});

	// Move the nodes close to the surface onto it, so that the physical
	// body matches the rendered one and touches the floor where it should
	const moved = new Set();

	for (const tet of kept) {
		for (const node of tet) {
			if (!moved.has(node) && distances[node] > -0.32 * h) {
				projectOnSlice(points[node]);
				moved.add(node);
			}
		}
	}

	const flat = new Float64Array(points.length * 3);

	points.forEach((point, i) => flat.set(point, i * 3));

	const oriented = [];

	for (const tet of kept) {
		const signed = tetVolume(flat, tet[0], tet[1], tet[2], tet[3]);

		if (Math.abs(signed) < NOMINAL_TET_VOLUME * 0.06) continue;

		oriented.push(signed > 0 ? tet : [tet[1], tet[0], tet[2], tet[3]]);
	}

	// Only keep the largest connected block
	const groups = connectedTetGroups(oriented.flat(), points.length);
	const largest = groups.reduce((best, group) => (group.length > best.length ? group : best), []);
	const remap = new Map();
	const rest = [];
	const tets = [];

	for (const value of largest) {
		if (!remap.has(value)) {
			remap.set(value, rest.length / 3);
			rest.push(...points[value]);
		}

		tets.push(remap.get(value));
	}

	return { rest, tets };
}

// 8. Create the materials
// The color depends on the rest position of each pixel, so a fresh cut
// always reveals the right part of the fruit, wherever the blade went
// Both sides are drawn so that the back of the jelly shows through its front
const jellyMaterial = new THREE.MeshPhysicalMaterial({
	side: THREE.DoubleSide,
	shadowSide: THREE.FrontSide,
	roughness: 0.08,
	metalness: 0,
	ior: 1.34,
	transmission: 1,
	thickness: 0.5,
	specularIntensity: 0.6,
	clearcoat: 0.25,
	clearcoatRoughness: 0.2
});

const jellyUniforms = {
	uRadius: { value: RADIUS },
	uFleshDeep: { value: new THREE.Color(0xf42f4a) },
	uFleshPale: { value: new THREE.Color(0xff8088) },
	uRindPale: { value: new THREE.Color(0xeef5c4) },
	uRindGreen: { value: new THREE.Color(0x8fce62) },
	uSkinLight: { value: new THREE.Color(0x3f9a3a) },
	uSkinDark: { value: new THREE.Color(0x0f5a26) }
};

jellyMaterial.onBeforeCompile = (shader) => {
	Object.assign(shader.uniforms, jellyUniforms);

	shader.vertexShader = shader.vertexShader
		.replace('#include <common>', `#include <common>
			attribute vec3 aRest;
			varying vec3 vRest;`)
		.replace('#include <begin_vertex>', `#include <begin_vertex>
			vRest = aRest;`);

	shader.fragmentShader = shader.fragmentShader
		.replace('#include <common>', `#include <common>
			varying vec3 vRest;
			uniform float uRadius;
			uniform vec3 uFleshDeep;
			uniform vec3 uFleshPale;
			uniform vec3 uRindPale;
			uniform vec3 uRindGreen;
			uniform vec3 uSkinLight;
			uniform vec3 uSkinDark;

			float jellyHash(vec3 p) {
				p = fract(p * 0.3183099 + 0.1);
				p *= 17.0;

				return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
			}

			float jellyNoise(vec3 p) {
				vec3 i = floor(p);
				vec3 f = fract(p);

				f = f * f * (3.0 - 2.0 * f);

				return mix(
					mix(
						mix(jellyHash(i), jellyHash(i + vec3(1, 0, 0)), f.x),
						mix(jellyHash(i + vec3(0, 1, 0)), jellyHash(i + vec3(1, 1, 0)), f.x),
						f.y
					),
					mix(
						mix(jellyHash(i + vec3(0, 0, 1)), jellyHash(i + vec3(1, 0, 1)), f.x),
						mix(jellyHash(i + vec3(0, 1, 1)), jellyHash(i + vec3(1, 1, 1)), f.x),
						f.y
					),
					f.z
				);
			}`)
		.replace('#include <color_fragment>', `#include <color_fragment>
			float jellyRadial = length(vRest.xy) / uRadius;
			float jellyWobble = (jellyNoise(vRest * 7.0) - 0.5) * 0.012;
			float jellyDepth = jellyRadial + jellyWobble;
			float jellyAngle = atan(vRest.x, -vRest.y);

			// Long irregular stripes on the skin
			float jellyStripe = sin(jellyAngle * 30.0 + (jellyNoise(vec3(jellyAngle * 5.0, vRest.z * 3.0, 2.0)) - 0.5) * 5.0);

			jellyStripe = smoothstep(-0.2, 0.25, jellyStripe);

			vec3 jellySkin = mix(uSkinLight, uSkinDark, jellyStripe);
			float jellyFleck = smoothstep(0.55, 0.8, jellyNoise(vRest * 30.0));
			vec3 jellyFlesh = mix(uFleshDeep, uFleshPale, smoothstep(0.55, 0.9, jellyDepth));

			jellyFlesh = mix(jellyFlesh, uFleshPale, jellyFleck * 0.14);

			vec3 jellyRind = mix(uRindPale, uRindGreen, smoothstep(0.885, 0.955, jellyDepth));
			vec3 jellyColor = mix(jellyFlesh, jellyRind, smoothstep(0.83, 0.865, jellyDepth));

			jellyColor = mix(jellyColor, jellySkin, smoothstep(0.945, 0.965, jellyDepth));

			// Seen through red jelly, the green rind on the far side would turn brown.
			// FLIP_SIDED marks the pass where the renderer draws the back faces
			#ifdef FLIP_SIDED
				jellyColor = mix(jellyColor, jellyFlesh, 0.85);
			#endif

			diffuseColor.rgb = jellyColor;

			float jellyClarity = mix(0.85, 0.18, smoothstep(0.83, 0.865, jellyDepth));

			jellyClarity = mix(jellyClarity, 0.04, smoothstep(0.945, 0.965, jellyDepth));`)
		.replace('#include <transmission_fragment>', THREE.ShaderChunk.transmission_fragment.replace(
			'material.transmission = transmission;',
			'material.transmission = transmission * jellyClarity;'
		));
};

const seedMaterial = new THREE.MeshStandardMaterial({
	color: 0x1a100b,
	roughness: 0.28
});

// 9. A piece is a block of tetrahedra with its rendered surfaces embedded inside
const pieces = [];
let nextPieceId = 1;

class EmbeddedSurface {
	constructor(data, piece, material, castShadow) {
		const count = data.rest.length / 3;

		this.count = count;
		this.rest = Float32Array.from(data.rest);
		this.index = Uint32Array.from(data.index);

		// Keep the weld ids small because clipping allocates by id
		const compact = new Map();

		this.weld = Int32Array.from(data.weld, (id) => {
			if (!compact.has(id)) compact.set(id, compact.size);

			return compact.get(id);
		});
		this.weldCount = compact.size;
		this.world = new Float32Array(count * 3);
		this.normal = new Float32Array(count * 3);
		this.nodes = new Int32Array(count * 4);
		this.weights = new Float32Array(count * 4);

		piece.embed(this);

		this.geometry = new THREE.BufferGeometry();
		this.geometry.setAttribute('position', new THREE.BufferAttribute(this.world, 3).setUsage(THREE.DynamicDrawUsage));
		this.geometry.setAttribute('normal', new THREE.BufferAttribute(this.normal, 3).setUsage(THREE.DynamicDrawUsage));
		this.geometry.setAttribute('aRest', new THREE.BufferAttribute(this.rest, 3));
		this.geometry.setIndex(new THREE.BufferAttribute(this.index, 1));

		this.mesh = new THREE.Mesh(this.geometry, material);
		this.mesh.frustumCulled = false;
		this.mesh.castShadow = castShadow;

		scene.add(this.mesh);
		this.update(piece.x);
	}

	update(x) {
		const { count, world, nodes, weights, normal, index } = this;

		for (let i = 0; i < count; i++) {
			const i3 = i * 3;
			const i4 = i * 4;
			const a = nodes[i4] * 3;
			const b = nodes[i4 + 1] * 3;
			const c = nodes[i4 + 2] * 3;
			const d = nodes[i4 + 3] * 3;
			const wa = weights[i4];
			const wb = weights[i4 + 1];
			const wc = weights[i4 + 2];
			const wd = weights[i4 + 3];
			const y = wa * x[a + 1] + wb * x[b + 1] + wc * x[c + 1] + wd * x[d + 1];

			world[i3] = wa * x[a] + wb * x[b] + wc * x[c] + wd * x[d];
			world[i3 + 1] = y > 0.002 ? y : 0.002;
			world[i3 + 2] = wa * x[a + 2] + wb * x[b + 2] + wc * x[c + 2] + wd * x[d + 2];
		}

		normal.fill(0);

		for (let t = 0; t < index.length; t += 3) {
			const a = index[t] * 3;
			const b = index[t + 1] * 3;
			const c = index[t + 2] * 3;
			const ux = world[b] - world[a];
			const uy = world[b + 1] - world[a + 1];
			const uz = world[b + 2] - world[a + 2];
			const vx = world[c] - world[a];
			const vy = world[c + 1] - world[a + 1];
			const vz = world[c + 2] - world[a + 2];
			const nx = uy * vz - uz * vy;
			const ny = uz * vx - ux * vz;
			const nz = ux * vy - uy * vx;

			normal[a] += nx;
			normal[a + 1] += ny;
			normal[a + 2] += nz;
			normal[b] += nx;
			normal[b + 1] += ny;
			normal[b + 2] += nz;
			normal[c] += nx;
			normal[c + 1] += ny;
			normal[c + 2] += nz;
		}

		for (let i = 0; i < count * 3; i += 3) {
			const length = Math.hypot(normal[i], normal[i + 1], normal[i + 2]) || 1;

			normal[i] /= length;
			normal[i + 1] /= length;
			normal[i + 2] /= length;
		}

		this.geometry.attributes.position.needsUpdate = true;
		this.geometry.attributes.normal.needsUpdate = true;
	}

	dispose() {
		scene.remove(this.mesh);
		this.geometry.dispose();
	}
}

class Piece {
	constructor({ rest, position, velocity, tets, flesh, seeds }) {
		this.id = nextPieceId++;
		this.immuneStroke = 0;
		this.side = 0;
		this.nodeCount = rest.length / 3;
		this.r = Float64Array.from(rest);
		this.x = Float64Array.from(position);
		this.p = Float64Array.from(position);
		this.v = Float64Array.from(velocity);
		this.tets = Int32Array.from(tets);
		this.tetCount = tets.length / 4;
		this.invDm = new Float64Array(this.tetCount * 9);
		this.alphaDev = new Float64Array(this.tetCount);
		this.alphaVol = new Float64Array(this.tetCount);
		this.w = new Float64Array(this.nodeCount);
		this.min = new Float64Array(3);
		this.max = new Float64Array(3);
		this.center = new Float64Array(3);
		this.volume = 0;

		this.prepareElements();
		this.findBoundary();
		this.buildEmbedIndex();

		this.flesh = new EmbeddedSurface(flesh, this, jellyMaterial, true);
		this.seeds = seeds && seeds.index.length > 0 ? new EmbeddedSurface(seeds, this, seedMaterial, false) : null;

		this.embedIndex = null;
		this.updateBounds();
	}

	prepareElements() {
		const { r, tets, invDm, alphaDev, alphaVol, tetCount } = this;
		const mass = new Float64Array(this.nodeCount);
		const dt2 = SUBSTEP * SUBSTEP;

		for (let t = 0; t < tetCount; t++) {
			const a = tets[t * 4] * 3;
			const b = tets[t * 4 + 1] * 3;
			const c = tets[t * 4 + 2] * 3;
			const d = tets[t * 4 + 3] * 3;
			const m00 = r[b] - r[a];
			const m10 = r[b + 1] - r[a + 1];
			const m20 = r[b + 2] - r[a + 2];
			const m01 = r[c] - r[a];
			const m11 = r[c + 1] - r[a + 1];
			const m21 = r[c + 2] - r[a + 2];
			const m02 = r[d] - r[a];
			const m12 = r[d + 1] - r[a + 1];
			const m22 = r[d + 2] - r[a + 2];
			const c00 = m11 * m22 - m12 * m21;
			const c10 = m12 * m20 - m10 * m22;
			const c20 = m10 * m21 - m11 * m20;
			const determinant = m00 * c00 + m01 * c10 + m02 * c20;
			const inverse = 1 / determinant;
			const t9 = t * 9;

			// invDm is the inverse of the matrix of rest edges, row by row
			invDm[t9] = c00 * inverse;
			invDm[t9 + 1] = (m02 * m21 - m01 * m22) * inverse;
			invDm[t9 + 2] = (m01 * m12 - m02 * m11) * inverse;
			invDm[t9 + 3] = c10 * inverse;
			invDm[t9 + 4] = (m00 * m22 - m02 * m20) * inverse;
			invDm[t9 + 5] = (m02 * m10 - m00 * m12) * inverse;
			invDm[t9 + 6] = c20 * inverse;
			invDm[t9 + 7] = (m01 * m20 - m00 * m21) * inverse;
			invDm[t9 + 8] = (m00 * m11 - m01 * m10) * inverse;

			const volume = determinant / 6;

			this.volume += volume;

			for (let corner = 0; corner < 4; corner++) {
				mass[tets[t * 4 + corner]] += DENSITY * volume / 4;
			}

			// Firmer rind: compare the distance to the tip with the rind radius
			const cx = (r[a] + r[b] + r[c] + r[d]) / 4;
			const cy = (r[a + 1] + r[b + 1] + r[c + 1] + r[d + 1]) / 4;
			const firm = THREE.MathUtils.smoothstep(Math.hypot(cx, cy) / RADIUS, 0.78, 0.9);
			const mu = SHEAR_MODULUS * (1 + (RIND_STIFFNESS - 1) * firm);

			alphaDev[t] = 1 / (mu * volume * dt2);
			alphaVol[t] = 1 / (mu * BULK_RATIO * volume * dt2);
		}

		for (let i = 0; i < this.nodeCount; i++) {
			this.w[i] = mass[i] > 0 ? 1 / mass[i] : 0;
		}
	}

	findBoundary() {
		const { tets, tetCount } = this;
		const faces = new Map();
		const nodes = this.nodeCount;

		function add(a, b, c) {
			const sorted = [a, b, c].sort((p, q) => p - q);
			const key = (sorted[0] * nodes + sorted[1]) * nodes + sorted[2];

			faces.set(key, (faces.get(key) ?? 0) + 1);
		}

		for (let t = 0; t < tetCount; t++) {
			const a = tets[t * 4];
			const b = tets[t * 4 + 1];
			const c = tets[t * 4 + 2];
			const d = tets[t * 4 + 3];

			add(a, b, c);
			add(a, b, d);
			add(a, c, d);
			add(b, c, d);
		}

		const boundary = new Set();

		for (const [key, count] of faces) {
			if (count !== 1) continue;

			const third = key % nodes;
			const rest = (key - third) / nodes;
			const second = rest % nodes;

			boundary.add(third);
			boundary.add(second);
			boundary.add((rest - second) / nodes);
		}

		this.boundary = Int32Array.from(boundary);
	}

	buildEmbedIndex() {
		const { r, tets, tetCount } = this;
		const index = new Map();
		const cell = LATTICE_CELL;

		for (let t = 0; t < tetCount; t++) {
			const low = [Infinity, Infinity, Infinity];
			const high = [-Infinity, -Infinity, -Infinity];

			for (let corner = 0; corner < 4; corner++) {
				const node = tets[t * 4 + corner] * 3;

				for (let c = 0; c < 3; c++) {
					low[c] = Math.min(low[c], r[node + c]);
					high[c] = Math.max(high[c], r[node + c]);
				}
			}

			for (let k = Math.floor(low[2] / cell); k <= Math.floor(high[2] / cell); k++) {
				for (let j = Math.floor(low[1] / cell); j <= Math.floor(high[1] / cell); j++) {
					for (let i = Math.floor(low[0] / cell); i <= Math.floor(high[0] / cell); i++) {
						const key = `${i},${j},${k}`;

						if (!index.has(key)) index.set(key, []);

						index.get(key).push(t);
					}
				}
			}
		}

		this.embedIndex = index;
	}

	// Barycentric score of a rest point in a tet: the higher the more inside
	tetScore(t, px, py, pz, out) {
		const { r, tets, invDm } = this;
		const a = tets[t * 4] * 3;
		const dx = px - r[a];
		const dy = py - r[a + 1];
		const dz = pz - r[a + 2];
		const t9 = t * 9;
		const b1 = invDm[t9] * dx + invDm[t9 + 1] * dy + invDm[t9 + 2] * dz;
		const b2 = invDm[t9 + 3] * dx + invDm[t9 + 4] * dy + invDm[t9 + 5] * dz;
		const b3 = invDm[t9 + 6] * dx + invDm[t9 + 7] * dy + invDm[t9 + 8] * dz;
		const b0 = 1 - b1 - b2 - b3;

		out[0] = b0;
		out[1] = b1;
		out[2] = b2;
		out[3] = b3;

		return Math.min(b0, b1, b2, b3);
	}

	embed(surface) {
		const { rest, count, nodes, weights } = surface;
		const { tets, tetCount, embedIndex } = this;
		const cell = LATTICE_CELL;
		const trial = [0, 0, 0, 0];
		const best = [0, 0, 0, 0];

		for (let v = 0; v < count; v++) {
			const px = rest[v * 3];
			const py = rest[v * 3 + 1];
			const pz = rest[v * 3 + 2];
			const ci = Math.floor(px / cell);
			const cj = Math.floor(py / cell);
			const ck = Math.floor(pz / cell);
			let bestScore = -Infinity;
			let bestTet = -1;

			const visit = (t) => {
				const score = this.tetScore(t, px, py, pz, trial);

				if (score > bestScore) {
					bestScore = score;
					bestTet = t;
					best[0] = trial[0];
					best[1] = trial[1];
					best[2] = trial[2];
					best[3] = trial[3];
				}
			};

			embedIndex.get(`${ci},${cj},${ck}`)?.forEach(visit);

			// Vertices just outside the block extrapolate from the closest tet
			if (bestScore < -1e-4) {
				for (let k = ck - 1; k <= ck + 1; k++) {
					for (let j = cj - 1; j <= cj + 1; j++) {
						for (let i = ci - 1; i <= ci + 1; i++) {
							embedIndex.get(`${i},${j},${k}`)?.forEach(visit);
						}
					}
				}
			}

			if (bestTet < 0) {
				for (let t = 0; t < tetCount; t++) visit(t);
			}

			for (let c = 0; c < 4; c++) {
				nodes[v * 4 + c] = tets[bestTet * 4 + c];
				weights[v * 4 + c] = best[c];
			}
		}
	}

	updateBounds() {
		const { x, min, max, center, boundary } = this;

		min.fill(Infinity);
		max.fill(-Infinity);
		center.fill(0);

		for (let i = 0; i < boundary.length; i++) {
			const node = boundary[i] * 3;

			for (let c = 0; c < 3; c++) {
				const value = x[node + c];

				if (value < min[c]) min[c] = value;
				if (value > max[c]) max[c] = value;

				center[c] += value;
			}
		}

		for (let c = 0; c < 3; c++) center[c] /= boundary.length;
	}

	updateSurfaces() {
		this.flesh.update(this.x);
		this.seeds?.update(this.x);
	}

	dispose() {
		this.flesh.dispose();
		this.seeds?.dispose();
	}
}

// 10. Simulate the jelly: stable neo-Hookean tetrahedra solved with XPBD
function integrate(piece) {
	const { x, p, v, nodeCount } = piece;
	const dt = SUBSTEP;

	for (let i = 0; i < nodeCount; i++) {
		const i3 = i * 3;

		v[i3 + 1] -= GRAVITY * dt;
		p[i3] = x[i3];
		p[i3 + 1] = x[i3 + 1];
		p[i3 + 2] = x[i3 + 2];
		x[i3] += v[i3] * dt;
		x[i3 + 1] += v[i3 + 1] * dt;
		x[i3 + 2] += v[i3 + 2] * dt;
	}
}

function solveElements(piece) {
	const { x, p, w, tets, invDm, alphaDev, alphaVol, tetCount } = piece;
	const damping = VISCOSITY / SUBSTEP;
	const restVolume = 1 + 1 / BULK_RATIO;

	for (let t = 0; t < tetCount; t++) {
		const t4 = t * 4;
		const t9 = t * 9;
		const n0 = tets[t4];
		const n1 = tets[t4 + 1];
		const n2 = tets[t4 + 2];
		const n3 = tets[t4 + 3];
		const a = n0 * 3;
		const b = n1 * 3;
		const c = n2 * 3;
		const d = n3 * 3;
		const wa = w[n0];
		const wb = w[n1];
		const wc = w[n2];
		const wd = w[n3];
		const r00 = invDm[t9];
		const r01 = invDm[t9 + 1];
		const r02 = invDm[t9 + 2];
		const r10 = invDm[t9 + 3];
		const r11 = invDm[t9 + 4];
		const r12 = invDm[t9 + 5];
		const r20 = invDm[t9 + 6];
		const r21 = invDm[t9 + 7];
		const r22 = invDm[t9 + 8];

		// Shear energy, with viscous damping of the deformation
		let e1x = x[b] - x[a];
		let e1y = x[b + 1] - x[a + 1];
		let e1z = x[b + 2] - x[a + 2];
		let e2x = x[c] - x[a];
		let e2y = x[c + 1] - x[a + 1];
		let e2z = x[c + 2] - x[a + 2];
		let e3x = x[d] - x[a];
		let e3y = x[d + 1] - x[a + 1];
		let e3z = x[d + 2] - x[a + 2];
		let f0x = e1x * r00 + e2x * r10 + e3x * r20;
		let f0y = e1y * r00 + e2y * r10 + e3y * r20;
		let f0z = e1z * r00 + e2z * r10 + e3z * r20;
		let f1x = e1x * r01 + e2x * r11 + e3x * r21;
		let f1y = e1y * r01 + e2y * r11 + e3y * r21;
		let f1z = e1z * r01 + e2z * r11 + e3z * r21;
		let f2x = e1x * r02 + e2x * r12 + e3x * r22;
		let f2y = e1y * r02 + e2y * r12 + e3y * r22;
		let f2z = e1z * r02 + e2z * r12 + e3z * r22;
		const norm = Math.sqrt(f0x * f0x + f0y * f0y + f0z * f0z + f1x * f1x + f1y * f1y + f1z * f1z + f2x * f2x + f2y * f2y + f2z * f2z);

		if (norm > 1e-9) {
			const scale = 1 / norm;
			const g1x = (f0x * r00 + f1x * r01 + f2x * r02) * scale;
			const g1y = (f0y * r00 + f1y * r01 + f2y * r02) * scale;
			const g1z = (f0z * r00 + f1z * r01 + f2z * r02) * scale;
			const g2x = (f0x * r10 + f1x * r11 + f2x * r12) * scale;
			const g2y = (f0y * r10 + f1y * r11 + f2y * r12) * scale;
			const g2z = (f0z * r10 + f1z * r11 + f2z * r12) * scale;
			const g3x = (f0x * r20 + f1x * r21 + f2x * r22) * scale;
			const g3y = (f0y * r20 + f1y * r21 + f2y * r22) * scale;
			const g3z = (f0z * r20 + f1z * r21 + f2z * r22) * scale;
			const g0x = -g1x - g2x - g3x;
			const g0y = -g1y - g2y - g3y;
			const g0z = -g1z - g2z - g3z;
			const rate = g0x * (x[a] - p[a]) + g0y * (x[a + 1] - p[a + 1]) + g0z * (x[a + 2] - p[a + 2])
				+ g1x * (x[b] - p[b]) + g1y * (x[b + 1] - p[b + 1]) + g1z * (x[b + 2] - p[b + 2])
				+ g2x * (x[c] - p[c]) + g2y * (x[c + 1] - p[c + 1]) + g2z * (x[c + 2] - p[c + 2])
				+ g3x * (x[d] - p[d]) + g3y * (x[d + 1] - p[d + 1]) + g3z * (x[d + 2] - p[d + 2]);
			const weight = wa * (g0x * g0x + g0y * g0y + g0z * g0z)
				+ wb * (g1x * g1x + g1y * g1y + g1z * g1z)
				+ wc * (g2x * g2x + g2y * g2y + g2z * g2z)
				+ wd * (g3x * g3x + g3y * g3y + g3z * g3z);
			const lambda = -(norm + damping * rate) / ((1 + damping) * weight + alphaDev[t]);

			x[a] += wa * lambda * g0x;
			x[a + 1] += wa * lambda * g0y;
			x[a + 2] += wa * lambda * g0z;
			x[b] += wb * lambda * g1x;
			x[b + 1] += wb * lambda * g1y;
			x[b + 2] += wb * lambda * g1z;
			x[c] += wc * lambda * g2x;
			x[c + 1] += wc * lambda * g2y;
			x[c + 2] += wc * lambda * g2z;
			x[d] += wd * lambda * g3x;
			x[d + 1] += wd * lambda * g3y;
			x[d + 2] += wd * lambda * g3z;
		}

		// Volume energy: jelly is mostly water and barely compresses
		e1x = x[b] - x[a];
		e1y = x[b + 1] - x[a + 1];
		e1z = x[b + 2] - x[a + 2];
		e2x = x[c] - x[a];
		e2y = x[c + 1] - x[a + 1];
		e2z = x[c + 2] - x[a + 2];
		e3x = x[d] - x[a];
		e3y = x[d + 1] - x[a + 1];
		e3z = x[d + 2] - x[a + 2];
		f0x = e1x * r00 + e2x * r10 + e3x * r20;
		f0y = e1y * r00 + e2y * r10 + e3y * r20;
		f0z = e1z * r00 + e2z * r10 + e3z * r20;
		f1x = e1x * r01 + e2x * r11 + e3x * r21;
		f1y = e1y * r01 + e2y * r11 + e3y * r21;
		f1z = e1z * r01 + e2z * r11 + e3z * r21;
		f2x = e1x * r02 + e2x * r12 + e3x * r22;
		f2y = e1y * r02 + e2y * r12 + e3y * r22;
		f2z = e1z * r02 + e2z * r12 + e3z * r22;

		const c0x = f1y * f2z - f1z * f2y;
		const c0y = f1z * f2x - f1x * f2z;
		const c0z = f1x * f2y - f1y * f2x;
		const c1x = f2y * f0z - f2z * f0y;
		const c1y = f2z * f0x - f2x * f0z;
		const c1z = f2x * f0y - f2y * f0x;
		const c2x = f0y * f1z - f0z * f1y;
		const c2y = f0z * f1x - f0x * f1z;
		const c2z = f0x * f1y - f0y * f1x;
		const constraint = f0x * c0x + f0y * c0y + f0z * c0z - restVolume;
		const h1x = c0x * r00 + c1x * r01 + c2x * r02;
		const h1y = c0y * r00 + c1y * r01 + c2y * r02;
		const h1z = c0z * r00 + c1z * r01 + c2z * r02;
		const h2x = c0x * r10 + c1x * r11 + c2x * r12;
		const h2y = c0y * r10 + c1y * r11 + c2y * r12;
		const h2z = c0z * r10 + c1z * r11 + c2z * r12;
		const h3x = c0x * r20 + c1x * r21 + c2x * r22;
		const h3y = c0y * r20 + c1y * r21 + c2y * r22;
		const h3z = c0z * r20 + c1z * r21 + c2z * r22;
		const h0x = -h1x - h2x - h3x;
		const h0y = -h1y - h2y - h3y;
		const h0z = -h1z - h2z - h3z;
		const weight = wa * (h0x * h0x + h0y * h0y + h0z * h0z)
			+ wb * (h1x * h1x + h1y * h1y + h1z * h1z)
			+ wc * (h2x * h2x + h2y * h2y + h2z * h2z)
			+ wd * (h3x * h3x + h3y * h3y + h3z * h3z);
		const lambda = -constraint / (weight + alphaVol[t]);

		x[a] += wa * lambda * h0x;
		x[a + 1] += wa * lambda * h0y;
		x[a + 2] += wa * lambda * h0z;
		x[b] += wb * lambda * h1x;
		x[b + 1] += wb * lambda * h1y;
		x[b + 2] += wb * lambda * h1z;
		x[c] += wc * lambda * h2x;
		x[c + 1] += wc * lambda * h2y;
		x[c + 2] += wc * lambda * h2z;
		x[d] += wd * lambda * h3x;
		x[d + 1] += wd * lambda * h3y;
		x[d + 2] += wd * lambda * h3z;
	}
}

function solveFloor(piece) {
	const { x, p, nodeCount } = piece;

	for (let i = 0; i < nodeCount; i++) {
		const i3 = i * 3;
		const depth = -x[i3 + 1];

		if (depth <= 0) continue;

		x[i3 + 1] = 0;

		// Coulomb friction: the grip is proportional to the contact force
		const dx = x[i3] - p[i3];
		const dz = x[i3 + 2] - p[i3 + 2];
		const slide = Math.hypot(dx, dz);

		if (slide > 1e-12) {
			const keep = Math.max(0, 1 - GROUND_FRICTION * depth / slide);

			x[i3] = p[i3] + dx * keep;
			x[i3 + 2] = p[i3 + 2] + dz * keep;
		}
	}
}

// Pieces come from a convex slice cut by planes, so two of them can always be
// separated by a plane: each pair tracks this plane instead of testing triangles
const contactPairs = new Map();
const separation = { gap: 0, nodeA: 0, nodeB: 0 };
let activePairs = [];

function pairKey(a, b) {
	return a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
}

function measureSeparation(a, b, nx, ny, nz) {
	let maxA = -Infinity;
	let minB = Infinity;
	let nodeA = 0;
	let nodeB = 0;

	for (let i = 0; i < a.boundary.length; i++) {
		const node = a.boundary[i] * 3;
		const value = a.x[node] * nx + a.x[node + 1] * ny + a.x[node + 2] * nz;

		if (value > maxA) {
			maxA = value;
			nodeA = node;
		}
	}

	for (let i = 0; i < b.boundary.length; i++) {
		const node = b.boundary[i] * 3;
		const value = b.x[node] * nx + b.x[node + 1] * ny + b.x[node + 2] * nz;

		if (value < minB) {
			minB = value;
			nodeB = node;
		}
	}

	separation.gap = minB - maxA;
	separation.nodeA = nodeA;
	separation.nodeB = nodeB;

	return separation.gap;
}

// Climbs toward the plane that leaves the widest gap between the two pieces
function refineSeparatingPlane(pair, iterations) {
	const { low: a, high: b } = pair;
	let { nx, ny, nz } = pair;
	let current = measureSeparation(a, b, nx, ny, nz);
	let step = 0.35;
	let length = Math.hypot(b.center[0] - a.center[0], b.center[1] - a.center[1], b.center[2] - a.center[2]) || 1;
	const cx = (b.center[0] - a.center[0]) / length;
	const cy = (b.center[1] - a.center[1]) / length;
	const cz = (b.center[2] - a.center[2]) / length;
	const fromCenters = measureSeparation(a, b, cx, cy, cz);

	if (fromCenters > current) {
		nx = cx;
		ny = cy;
		nz = cz;
		current = fromCenters;
	}

	for (let iteration = 0; iteration < iterations; iteration++) {
		measureSeparation(a, b, nx, ny, nz);

		const { nodeA, nodeB } = separation;
		let dx = b.x[nodeB] - a.x[nodeA];
		let dy = b.x[nodeB + 1] - a.x[nodeA + 1];
		let dz = b.x[nodeB + 2] - a.x[nodeA + 2];

		length = Math.hypot(dx, dy, dz) || 1;
		dx = nx + step * dx / length;
		dy = ny + step * dy / length;
		dz = nz + step * dz / length;
		length = Math.hypot(dx, dy, dz) || 1;
		dx /= length;
		dy /= length;
		dz /= length;

		const gap = measureSeparation(a, b, dx, dy, dz);

		if (gap > current) {
			nx = dx;
			ny = dy;
			nz = dz;
			current = gap;
		} else {
			step *= 0.5;
		}
	}

	pair.nx = nx;
	pair.ny = ny;
	pair.nz = nz;
}

function getPair(a, b) {
	const key = pairKey(a, b);
	let pair = contactPairs.get(key);

	if (!pair) {
		const [low, high] = a.id < b.id ? [a, b] : [b, a];
		const dx = high.center[0] - low.center[0];
		const dy = high.center[1] - low.center[1];
		const dz = high.center[2] - low.center[2];
		const length = Math.hypot(dx, dy, dz) || 1;

		pair = { low, high, nx: dx / length, ny: dy / length, nz: dz / length };
		contactPairs.set(key, pair);
		refineSeparatingPlane(pair, 16);
	}

	return pair;
}

function updateContactPairs() {
	const reach = 0.2;

	activePairs = [];

	for (let i = 0; i < pieces.length; i++) {
		const a = pieces[i];

		a.updateBounds();

		for (let j = 0; j < i; j++) {
			const b = pieces[j];

			if (
				a.min[0] > b.max[0] + reach || b.min[0] > a.max[0] + reach ||
				a.min[1] > b.max[1] + reach || b.min[1] > a.max[1] + reach ||
				a.min[2] > b.max[2] + reach || b.min[2] > a.max[2] + reach
			) continue;

			const pair = getPair(a, b);

			refineSeparatingPlane(pair, 4);
			activePairs.push(pair);
		}
	}
}

function meanMotion(piece) {
	const { x, p, nodeCount } = piece;
	let mx = 0;
	let my = 0;
	let mz = 0;

	for (let i = 0; i < nodeCount * 3; i += 3) {
		mx += x[i] - p[i];
		my += x[i + 1] - p[i + 1];
		mz += x[i + 2] - p[i + 2];
	}

	return [mx / nodeCount, my / nodeCount, mz / nodeCount];
}

function pushOutOfPlane(piece, nx, ny, nz, plane, direction, otherMotion) {
	const { x, p, boundary } = piece;

	for (let i = 0; i < boundary.length; i++) {
		const node = boundary[i] * 3;
		const depth = direction * (x[node] * nx + x[node + 1] * ny + x[node + 2] * nz - plane);

		if (depth <= 0) continue;

		x[node] -= direction * nx * depth;
		x[node + 1] -= direction * ny * depth;
		x[node + 2] -= direction * nz * depth;

		// Slippery friction relative to the other piece
		let dx = x[node] - p[node] - otherMotion[0];
		let dy = x[node + 1] - p[node + 1] - otherMotion[1];
		let dz = x[node + 2] - p[node + 2] - otherMotion[2];
		const normal = dx * nx + dy * ny + dz * nz;

		dx -= normal * nx;
		dy -= normal * ny;
		dz -= normal * nz;

		const slide = Math.hypot(dx, dy, dz);

		if (slide > 1e-12) {
			const grip = Math.min(1, JELLY_FRICTION * depth / slide);

			x[node] -= dx * grip;
			x[node + 1] -= dy * grip;
			x[node + 2] -= dz * grip;
		}
	}
}

function solvePair(pair) {
	const { low, high, nx, ny, nz } = pair;
	let maxLow = -Infinity;
	let minHigh = Infinity;

	for (let i = 0; i < low.boundary.length; i++) {
		const node = low.boundary[i] * 3;
		const value = low.x[node] * nx + low.x[node + 1] * ny + low.x[node + 2] * nz;

		if (value > maxLow) maxLow = value;
	}

	for (let i = 0; i < high.boundary.length; i++) {
		const node = high.boundary[i] * 3;
		const value = high.x[node] * nx + high.x[node + 1] * ny + high.x[node + 2] * nz;

		if (value < minHigh) minHigh = value;
	}

	if (minHigh - maxLow >= CONTACT_MARGIN) return;

	const plane = (maxLow + minHigh) / 2;
	const half = CONTACT_MARGIN / 2;
	const lowMotion = meanMotion(low);
	const highMotion = meanMotion(high);

	pushOutOfPlane(low, nx, ny, nz, plane - half, 1, highMotion);
	pushOutOfPlane(high, nx, ny, nz, plane + half, -1, lowMotion);
}

function updateVelocities(piece) {
	const { x, p, v, nodeCount } = piece;
	const inverse = 1 / SUBSTEP;

	for (let i = 0; i < nodeCount; i++) {
		const i3 = i * 3;
		let vx = (x[i3] - p[i3]) * inverse;
		let vy = (x[i3 + 1] - p[i3 + 1]) * inverse;
		let vz = (x[i3 + 2] - p[i3 + 2]) * inverse;
		const speed = vx * vx + vy * vy + vz * vz;

		if (speed > MAX_SPEED * MAX_SPEED) {
			const scale = MAX_SPEED / Math.sqrt(speed);

			vx *= scale;
			vy *= scale;
			vz *= scale;
		}

		v[i3] = vx;
		v[i3 + 1] = vy;
		v[i3 + 2] = vz;
	}
}

function stepPhysics() {
	for (const piece of pieces) integrate(piece);
	for (const piece of pieces) solveElements(piece);
	for (const pair of activePairs) solvePair(pair);
	for (const piece of pieces) solveFloor(piece);
	for (const piece of pieces) updateVelocities(piece);
}

// 11. Cut a piece along a world-space plane
function pointInPolygon(point, polygon) {
	let inside = false;

	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const a = polygon[i];
		const b = polygon[j];

		if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) {
			inside = !inside;
		}
	}

	return inside;
}

function signedArea(a, b, c) {
	return (b.u - a.u) * (c.v - a.v) - (b.v - a.v) * (c.u - a.u);
}

function orientCounterClockwise(tri, vertices) {
	return signedArea(vertices[tri[0]], vertices[tri[1]], vertices[tri[2]]) >= 0 ? [tri[0], tri[1], tri[2]] : [tri[0], tri[2], tri[1]];
}

function flipToDelaunay(triangles, vertices) {
	const tris = triangles.map((tri) => [...tri]);
	const size = vertices.length + 1;

	for (let pass = 0; pass < 10; pass++) {
		const owners = new Map();

		tris.forEach((tri, t) => {
			for (let e = 0; e < 3; e++) {
				owners.set(tri[e] * size + tri[(e + 1) % 3], t);
			}
		});

		const touched = new Set();
		let flips = 0;

		for (let t = 0; t < tris.length; t++) {
			if (touched.has(t)) continue;

			for (let e = 0; e < 3; e++) {
				const tri = tris[t];
				const a = tri[e];
				const b = tri[(e + 1) % 3];
				const c = tri[(e + 2) % 3];
				const other = owners.get(b * size + a);

				if (other === undefined || touched.has(other) || other === t) continue;

				const d = tris[other].find((vertex) => vertex !== a && vertex !== b);
				const va = vertices[a];
				const vb = vertices[b];
				const vc = vertices[c];
				const vd = vertices[d];

				// The quad must stay convex for the flip to be valid
				if (signedArea(vc, va, vd) <= 1e-9 || signedArea(vd, vb, vc) <= 1e-9) continue;

				const ax = va.u - vd.u;
				const ay = va.v - vd.v;
				const bx = vb.u - vd.u;
				const by = vb.v - vd.v;
				const cx = vc.u - vd.u;
				const cy = vc.v - vd.v;
				const inCircle = (ax * ax + ay * ay) * (bx * cy - cx * by)
					- (bx * bx + by * by) * (ax * cy - cx * ay)
					+ (cx * cx + cy * cy) * (ax * by - bx * ay);

				if (inCircle > 1e-9) {
					tris[t] = [c, a, d];
					tris[other] = [d, b, c];
					touched.add(t);
					touched.add(other);
					flips++;
					break;
				}
			}
		}

		if (flips === 0) break;
	}

	return tris;
}

// A cut face must have interior vertices to deform with the jelly: subdivide
// the long edges, then flip edges to keep the triangles well shaped
function refineCap(vertices, triangles, allocateWeld) {
	let tris = triangles;
	const maxLength2 = CAP_EDGE * CAP_EDGE;

	for (let round = 0; round < 7; round++) {
		tris = flipToDelaunay(tris, vertices);

		const edgeUse = new Map();
		const size = vertices.length + 1;
		const edgeKey = (a, b) => (a < b ? a * size + b : b * size + a);

		for (const tri of tris) {
			for (let e = 0; e < 3; e++) {
				const key = edgeKey(tri[e], tri[(e + 1) % 3]);

				edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
			}
		}

		const midpoints = new Map();

		// Edges used once lie on the outline and must match the side surface
		const midpoint = (a, b) => {
			const key = edgeKey(a, b);

			if (edgeUse.get(key) !== 2) return -1;

			const pa = vertices[a];
			const pb = vertices[b];

			if ((pa.u - pb.u) ** 2 + (pa.v - pb.v) ** 2 <= maxLength2) return -1;

			let id = midpoints.get(key);

			if (id === undefined) {
				id = vertices.length;
				midpoints.set(key, id);
				vertices.push({
					id: allocateWeld(),
					u: (pa.u + pb.u) / 2,
					v: (pa.v + pb.v) / 2,
					rest: pa.rest.map((value, c) => (value + pb.rest[c]) / 2),
					world: pa.world.map((value, c) => (value + pb.world[c]) / 2)
				});
			}

			return id;
		};

		const split = [];

		for (const [a, b, c] of tris) {
			const ab = midpoint(a, b);
			const bc = midpoint(b, c);
			const ca = midpoint(c, a);

			if (ab >= 0 && bc >= 0 && ca >= 0) {
				split.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
			} else if (ab >= 0 && bc >= 0) {
				split.push([ab, b, bc], [a, ab, bc], [a, bc, c]);
			} else if (bc >= 0 && ca >= 0) {
				split.push([bc, c, ca], [b, bc, ca], [b, ca, a]);
			} else if (ca >= 0 && ab >= 0) {
				split.push([ca, a, ab], [c, ca, ab], [c, ab, b]);
			} else if (ab >= 0) {
				split.push([a, ab, c], [ab, b, c]);
			} else if (bc >= 0) {
				split.push([b, bc, a], [bc, c, a]);
			} else if (ca >= 0) {
				split.push([c, ca, b], [ca, a, b]);
			} else {
				split.push([a, b, c]);
			}
		}

		const finished = midpoints.size === 0;

		tris = split;

		if (finished) break;
	}

	return flipToDelaunay(tris, vertices);
}

function addCap(side, weldPoints, normal, allocateWeld) {
	const loops = [];
	const visited = new Set();

	for (const start of side.next.keys()) {
		if (visited.has(start)) continue;

		const loop = [];
		let current = start;

		while (current !== undefined && !visited.has(current)) {
			visited.add(current);
			loop.push(current);
			current = side.next.get(current);
		}

		if (current === start && loop.length >= 3) loops.push(loop);
	}

	if (loops.length === 0) return;

	// Flatten the loops in the plane, with axes such that u x v = normal
	const capNormal = new THREE.Vector3(...normal);
	const helper = Math.abs(normal[1]) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
	const axisU = helper.cross(capNormal).normalize();
	const axisV = capNormal.clone().cross(axisU);
	const flatLoops = loops.map((loop) => loop.map((id) => {
		const w = weldPoints.get(id).world;

		return new THREE.Vector2(
			axisU.x * w[0] + axisU.y * w[1] + axisU.z * w[2],
			axisV.x * w[0] + axisV.y * w[1] + axisV.z * w[2]
		);
	}));
	const areas = flatLoops.map((loop) => Math.abs(THREE.ShapeUtils.area(loop)));
	const order = loops.map((_, i) => i).sort((p, q) => areas[q] - areas[p]);
	const outers = [];

	// A loop inside an odd number of loops is a hole
	for (const loopIndex of order) {
		const point = flatLoops[loopIndex][0];
		let depth = 0;
		let parent = null;

		for (const other of order) {
			if (other === loopIndex || areas[other] < areas[loopIndex]) continue;

			if (pointInPolygon(point, flatLoops[other])) {
				depth++;
				parent = other;
			}
		}

		if (depth % 2 === 0) {
			outers.push({ contour: loopIndex, holes: [] });
		} else {
			outers.find((outer) => outer.contour === parent)?.holes.push(loopIndex);
		}
	}

	for (const { contour, holes } of outers) {
		const ids = [...loops[contour], ...holes.flatMap((hole) => loops[hole])];
		const uv = [...flatLoops[contour], ...holes.flatMap((hole) => flatLoops[hole])];
		const triangles = THREE.ShapeUtils.triangulateShape(
			flatLoops[contour].map((point) => point.clone()),
			holes.map((hole) => flatLoops[hole].map((point) => point.clone()))
		);
		const vertices = ids.map((id, i) => {
			const point = weldPoints.get(id);

			return { id, u: uv[i].x, v: uv[i].y, rest: point.rest, world: point.world };
		});
		const refined = refineCap(vertices, triangles.map((tri) => orientCounterClockwise(tri, vertices)), allocateWeld);
		const first = side.weld.length;

		for (const vertex of vertices) {
			side.rest.push(...vertex.rest);
			side.world.push(...vertex.world);
			side.weld.push(vertex.id);
		}

		for (const [a, b, c] of refined) {
			side.index.push(first + a, first + b, first + c);
		}
	}
}

// Clips a closed surface; returns the part on each side, with a capped cut face
function clipSurface(surface, nx, ny, nz, offset) {
	const { rest, world, weld, index, count } = surface;
	const distances = new Float64Array(surface.weldCount).fill(NaN);
	const d = new Float64Array(count);

	for (let v = 0; v < count; v++) {
		const id = weld[v];

		if (Number.isNaN(distances[id])) {
			const value = world[v * 3] * nx + world[v * 3 + 1] * ny + world[v * 3 + 2] * nz - offset;

			// No vertex lies exactly on the plane, so every crossing is on an edge
			distances[id] = Math.abs(value) < 1e-6 ? 1e-6 : value;
		}

		d[v] = distances[id];
	}

	const sides = [0, 1].map(() => ({
		rest: [],
		world: [],
		weld: [],
		index: [],
		vertexMap: new Int32Array(count).fill(-1),
		edgeMap: new Map(),
		next: new Map()
	}));
	const weldEdges = new Map();
	const weldPoints = new Map();
	let nextWeld = surface.weldCount;

	function addVertex(side, v) {
		const target = sides[side];

		if (target.vertexMap[v] < 0) {
			target.vertexMap[v] = target.weld.length;
			target.rest.push(rest[v * 3], rest[v * 3 + 1], rest[v * 3 + 2]);
			target.world.push(world[v * 3], world[v * 3 + 1], world[v * 3 + 2]);
			target.weld.push(weld[v]);
		}

		return target.vertexMap[v];
	}

	function addCrossing(side, v, u) {
		const target = sides[side];
		const [i, j] = weld[v] < weld[u] ? [v, u] : [u, v];
		const edgeKey = i * count + j;
		let vertex = target.edgeMap.get(edgeKey);

		if (vertex === undefined) {
			const weldKey = weld[i] * surface.weldCount + weld[j];
			let id = weldEdges.get(weldKey);

			if (id === undefined) {
				const s = d[i] / (d[i] - d[j]);

				id = nextWeld++;
				weldEdges.set(weldKey, id);
				weldPoints.set(id, {
					rest: [0, 1, 2].map((c) => rest[i * 3 + c] + (rest[j * 3 + c] - rest[i * 3 + c]) * s),
					world: [0, 1, 2].map((c) => world[i * 3 + c] + (world[j * 3 + c] - world[i * 3 + c]) * s)
				});
			}

			const point = weldPoints.get(id);

			vertex = target.weld.length;
			target.edgeMap.set(edgeKey, vertex);
			target.rest.push(...point.rest);
			target.world.push(...point.world);
			target.weld.push(id);
		}

		return vertex;
	}

	for (let t = 0; t < index.length; t += 3) {
		const a = index[t];
		const b = index[t + 1];
		const c = index[t + 2];
		const sa = d[a] > 0 ? 0 : 1;
		const sb = d[b] > 0 ? 0 : 1;
		const sc = d[c] > 0 ? 0 : 1;

		if (sa === sb && sb === sc) {
			sides[sa].index.push(addVertex(sa, a), addVertex(sa, b), addVertex(sa, c));
			continue;
		}

		// Rotate the triangle so that its first vertex is alone on its side
		const [lone, p, q] = sa === sb ? [c, a, b] : sa === sc ? [b, c, a] : [a, b, c];
		const loneSide = d[lone] > 0 ? 0 : 1;
		const otherSide = 1 - loneSide;
		const loneP = addCrossing(loneSide, lone, p);
		const loneQ = addCrossing(loneSide, lone, q);
		const otherP = addCrossing(otherSide, lone, p);
		const otherQ = addCrossing(otherSide, lone, q);

		sides[loneSide].index.push(addVertex(loneSide, lone), loneP, loneQ);

		const keptP = addVertex(otherSide, p);
		const keptQ = addVertex(otherSide, q);

		sides[otherSide].index.push(otherP, keptP, keptQ, otherP, keptQ, otherQ);

		// The cap must run against the open edge left on each side
		sides[loneSide].next.set(sides[loneSide].weld[loneQ], sides[loneSide].weld[loneP]);
		sides[otherSide].next.set(sides[otherSide].weld[otherP], sides[otherSide].weld[otherQ]);
	}

	sides.forEach((side, sideIndex) => {
		// The cut face looks away from the kept part
		const capNormal = sideIndex === 0 ? [-nx, -ny, -nz] : [nx, ny, nz];

		addCap(side, weldPoints, capNormal, () => nextWeld++);
	});

	return sides;
}

// Separates a clipped surface into its connected parts
function splitSurfaceParts(side) {
	if (side.index.length === 0) return [];

	const ids = new Map();
	const parent = [];

	function compact(id) {
		if (!ids.has(id)) {
			ids.set(id, parent.length);
			parent.push(parent.length);
		}

		return ids.get(id);
	}

	function find(node) {
		while (parent[node] !== node) {
			parent[node] = parent[parent[node]];
			node = parent[node];
		}

		return node;
	}

	for (let t = 0; t < side.index.length; t += 3) {
		const a = compact(side.weld[side.index[t]]);
		const b = compact(side.weld[side.index[t + 1]]);
		const c = compact(side.weld[side.index[t + 2]]);

		parent[find(b)] = find(a);
		parent[find(c)] = find(a);
	}

	const parts = new Map();

	for (let t = 0; t < side.index.length; t += 3) {
		const root = find(ids.get(side.weld[side.index[t]]));

		if (!parts.has(root)) {
			parts.set(root, { rest: [], weld: [], index: [], map: new Map() });
		}

		const part = parts.get(root);

		for (let c = 0; c < 3; c++) {
			const v = side.index[t + c];

			if (!part.map.has(v)) {
				part.map.set(v, part.weld.length);
				part.rest.push(side.rest[v * 3], side.rest[v * 3 + 1], side.rest[v * 3 + 2]);
				part.weld.push(side.weld[v]);
			}

			part.index.push(part.map.get(v));
		}
	}

	return [...parts.values()];
}

function mergeSurfaces(parts) {
	const merged = { rest: [], weld: [], index: [] };
	let offset = 0;
	let weldOffset = 0;

	for (const part of parts) {
		let highest = 0;

		for (const value of part.rest) merged.rest.push(value);

		for (const id of part.weld) {
			merged.weld.push(id + weldOffset);

			if (id > highest) highest = id;
		}

		for (const v of part.index) merged.index.push(v + offset);

		offset += part.weld.length;
		weldOffset += highest + 1;
	}

	return merged;
}

function surfaceCenter(part) {
	const count = part.rest.length / 3;
	const center = [0, 0, 0];

	for (let i = 0; i < part.rest.length; i += 3) {
		center[0] += part.rest[i];
		center[1] += part.rest[i + 1];
		center[2] += part.rest[i + 2];
	}

	return center.map((value) => value / count);
}

// Which group of tetrahedra is the closest to this rest point?
function findGroup(point, groups, r) {
	let bestGroup = 0;
	let bestDistance = Infinity;

	groups.forEach((group, g) => {
		for (let t = 0; t < group.length; t++) {
			const node = group[t] * 3;
			const distance = (r[node] - point[0]) ** 2 + (r[node + 1] - point[1]) ** 2 + (r[node + 2] - point[2]) ** 2;

			if (distance < bestDistance) {
				bestDistance = distance;
				bestGroup = g;
			}
		}
	});

	return bestGroup;
}

function cutPiece(piece, nx, ny, nz, offset, strokeId) {
	const { x, r, v, tets, tetCount, nodeCount } = piece;
	const d = new Float64Array(nodeCount);

	for (let i = 0; i < nodeCount; i++) {
		d[i] = x[i * 3] * nx + x[i * 3 + 1] * ny + x[i * 3 + 2] * nz - offset;
	}

	// Refuse the cuts that would only shave a crumb off
	const volumes = [0, 0];

	for (let t = 0; t < tetCount; t++) {
		const sum = d[tets[t * 4]] + d[tets[t * 4 + 1]] + d[tets[t * 4 + 2]] + d[tets[t * 4 + 3]];

		volumes[sum > 0 ? 0 : 1] += tetVolume(r, tets[t * 4], tets[t * 4 + 1], tets[t * 4 + 2], tets[t * 4 + 3]);
	}

	if (volumes[0] < MIN_PIECE_VOLUME || volumes[1] < MIN_PIECE_VOLUME) return false;
	if (pieces.length >= MAX_PIECES) return false;

	const { world, count } = piece.flesh;
	let reachPositive = 0;
	let reachNegative = 0;

	for (let i = 0; i < count; i++) {
		const distance = world[i * 3] * nx + world[i * 3 + 1] * ny + world[i * 3 + 2] * nz - offset;

		if (distance > reachPositive) reachPositive = distance;
		if (distance < reachNegative) reachNegative = distance;
	}

	if (reachPositive < MIN_PIECE_THICKNESS || -reachNegative < MIN_PIECE_THICKNESS) return false;

	const savedPosition = x.slice();
	const savedRest = r.slice();

	// Slide the nodes closest to the plane onto it, along the edges that cross
	// it: no tetrahedron straddles the plane anymore. Moving rest and current
	// positions together keeps the strain of the jelly nearly unchanged
	const seen = new Set();
	const crossings = [];
	const corners = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];

	for (let t = 0; t < tetCount; t++) {
		for (const [c0, c1] of corners) {
			const a = tets[t * 4 + c0];
			const b = tets[t * 4 + c1];
			const key = a < b ? a * nodeCount + b : b * nodeCount + a;

			if (seen.has(key)) continue;

			seen.add(key);

			if (d[a] * d[b] < 0) {
				const [near, far] = Math.abs(d[a]) < Math.abs(d[b]) ? [a, b] : [b, a];

				crossings.push({ near, far, s: d[near] / (d[near] - d[far]) });
			}
		}
	}

	crossings.sort((p, q) => p.s - q.s);

	for (const { near, far, s } of crossings) {
		if (d[near] * d[far] >= 0) continue;

		for (let c = 0; c < 3; c++) {
			x[near * 3 + c] += (x[far * 3 + c] - x[near * 3 + c]) * s;
			r[near * 3 + c] += (r[far * 3 + c] - r[near * 3 + c]) * s;
		}

		d[near] = 0;
	}

	// Sort the tetrahedra by side and drop the ones crushed by the snapping
	const sideTets = [[], []];

	for (let t = 0; t < tetCount; t++) {
		const a = tets[t * 4];
		const b = tets[t * 4 + 1];
		const c = tets[t * 4 + 2];
		const e = tets[t * 4 + 3];
		const sum = d[a] + d[b] + d[c] + d[e];

		if (sum === 0 || tetVolume(r, a, b, c, e) < NOMINAL_TET_VOLUME * 0.03) continue;

		sideTets[sum > 0 ? 0 : 1].push(a, b, c, e);
	}

	const fleshSides = clipSurface(piece.flesh, nx, ny, nz, offset);
	const seedSides = piece.seeds ? clipSurface(piece.seeds, nx, ny, nz, offset) : [null, null];
	const created = [];

	for (let side = 0; side < 2; side++) {
		const groups = connectedTetGroups(sideTets[side], nodeCount).filter((group) => group.length >= 16);

		if (groups.length === 0) continue;

		const fleshParts = groups.map(() => []);
		const seedParts = groups.map(() => []);

		for (const part of splitSurfaceParts(fleshSides[side])) {
			fleshParts[findGroup(surfaceCenter(part), groups, r)].push(part);
		}

		if (seedSides[side]) {
			for (const part of splitSurfaceParts(seedSides[side])) {
				seedParts[findGroup(surfaceCenter(part), groups, r)].push(part);
			}
		}

		groups.forEach((group, g) => {
			if (fleshParts[g].length === 0) return;

			const remap = new Map();
			const rest = [];
			const position = [];
			const velocity = [];
			const newTets = [];

			for (const node of group) {
				if (!remap.has(node)) {
					remap.set(node, rest.length / 3);

					for (let c = 0; c < 3; c++) {
						rest.push(r[node * 3 + c]);
						position.push(x[node * 3 + c]);
						velocity.push(v[node * 3 + c]);
					}
				}

				newTets.push(remap.get(node));
			}

			const child = new Piece({
				rest,
				position,
				velocity,
				tets: newTets,
				flesh: mergeSurfaces(fleshParts[g]),
				seeds: mergeSurfaces(seedParts[g])
			});

			child.immuneStroke = strokeId;
			child.side = side;
			created.push(child);
		});
	}

	if (!created.some((child) => child.side === 0) || !created.some((child) => child.side === 1)) {
		created.forEach((child) => child.dispose());
		x.set(savedPosition);
		r.set(savedRest);

		return false;
	}

	// Push the two sides apart; the light side moves more
	const sideMass = [0, 0];

	for (const child of created) sideMass[child.side] += child.volume;

	const total = sideMass[0] + sideMass[1];

	for (const child of created) {
		const direction = child.side === 0 ? 1 : -1;
		const speed = SPLIT_IMPULSE * direction * 2 * sideMass[1 - child.side] / total;

		for (let i = 0; i < child.nodeCount; i++) {
			child.v[i * 3] += nx * speed;
			child.v[i * 3 + 1] += ny * speed;
			child.v[i * 3 + 2] += nz * speed;
		}
	}

	// The new pieces inherit the separating planes of their parent
	for (const other of pieces) {
		if (other === piece) continue;

		const inherited = contactPairs.get(pairKey(piece, other));

		if (!inherited) continue;

		for (const child of created) {
			const sign = (inherited.low === piece) === (child.id < other.id) ? 1 : -1;
			const [low, high] = child.id < other.id ? [child, other] : [other, child];

			contactPairs.set(pairKey(child, other), {
				low,
				high,
				nx: inherited.nx * sign,
				ny: inherited.ny * sign,
				nz: inherited.nz * sign
			});
		}
	}

	for (const key of [...contactPairs.keys()]) {
		const pair = contactPairs.get(key);

		if (pair.low === piece || pair.high === piece) contactPairs.delete(key);
	}

	// Two pieces on either side of the cut are separated by the cut itself
	for (const a of created) {
		for (const b of created) {
			if (a.id >= b.id || a.side === b.side) continue;

			const sign = a.side === 1 ? 1 : -1;

			contactPairs.set(pairKey(a, b), { low: a, high: b, nx: nx * sign, ny: ny * sign, nz: nz * sign });
		}
	}

	pieces.splice(pieces.indexOf(piece), 1, ...created);
	piece.dispose();

	return true;
}

function createSliceFactory() {
	const lattice = buildLattice();
	const flesh = buildSliceSurface();
	const seeds = buildSeedSurface();
	const lift = RADIUS + 0.4;

	return () => {
		const position = Float64Array.from(lattice.rest);

		for (let i = 1; i < position.length; i += 3) position[i] += lift;

		return new Piece({
			rest: lattice.rest,
			position,
			velocity: new Float64Array(position.length),
			tets: lattice.tets,
			flesh,
			seeds
		});
	};
}

const spawnSlice = createSliceFactory();

function resetSlice() {
	for (const piece of pieces) piece.dispose();

	pieces.length = 0;
	contactPairs.clear();
	activePairs = [];
	pieces.push(spawnSlice());
}

resetSlice();

// 12. Create the knife
function createKnife() {
	const knife = new THREE.Group();
	const bladeShape = new THREE.Shape();

	bladeShape.moveTo(0, 0);
	bladeShape.lineTo(1.05, 0);
	bladeShape.quadraticCurveTo(1.55, 0.01, 1.85, 0.27);
	bladeShape.quadraticCurveTo(1.2, 0.33, 0, 0.33);
	bladeShape.closePath();

	const blade = new THREE.Mesh(
		new THREE.ExtrudeGeometry(bladeShape, {
			depth: 0.006,
			bevelEnabled: true,
			bevelThickness: 0.012,
			bevelSize: 0.012,
			bevelSegments: 2,
			curveSegments: 16
		}),
		// Darker than plain steel, or it would vanish against the white background
		new THREE.MeshStandardMaterial({ color: 0x8f98a3, metalness: 1, roughness: 0.3 })
	);

	const handleShape = new THREE.Shape();

	handleShape.moveTo(-0.95, 0.06);
	handleShape.quadraticCurveTo(-1.02, 0.17, -0.95, 0.31);
	handleShape.lineTo(-0.02, 0.33);
	handleShape.lineTo(-0.02, 0.09);
	handleShape.closePath();

	const handle = new THREE.Mesh(
		new THREE.ExtrudeGeometry(handleShape, {
			depth: 0.07,
			bevelEnabled: true,
			bevelThickness: 0.025,
			bevelSize: 0.025,
			bevelSegments: 3,
			curveSegments: 10
		}),
		new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.5 })
	);

	handle.position.z = -0.032;
	knife.add(blade, handle);

	const rivetGeometry = new THREE.CylinderGeometry(0.022, 0.022, 0.13, 12);
	const rivetMaterial = new THREE.MeshStandardMaterial({ color: 0xc9ccd1, metalness: 1, roughness: 0.3 });

	for (const rivetX of [-0.74, -0.45, -0.16]) {
		const rivet = new THREE.Mesh(rivetGeometry, rivetMaterial);

		rivet.rotation.x = Math.PI / 2;
		rivet.position.set(rivetX, 0.2, 0.003);
		knife.add(rivet);
	}

	// The pointer holds the cutting edge, toward the tip of the blade
	knife.children.forEach((part) => {
		part.position.x -= 1.15;
		part.castShadow = true;
	});

	const holder = new THREE.Group();

	holder.add(knife);
	holder.scale.setScalar(0.85);
	holder.visible = false;
	scene.add(holder);

	return holder;
}

const knife = createKnife();
const knifeTarget = new THREE.Vector3();
const knifeQuaternion = new THREE.Quaternion();
const knifeBasis = new THREE.Matrix4();
const strokeDirection = new THREE.Vector3(0, -1, 0);
const viewDirection = new THREE.Vector3();
const screenRight = new THREE.Vector3();
const screenUp = new THREE.Vector3();
const screenDown = new THREE.Vector3();
const bladeAxis = new THREE.Vector3();
const bladeSpine = new THREE.Vector3();
const bladeSide = new THREE.Vector3();
const bladeAcross = new THREE.Vector3();
const focusPlane = new THREE.Plane();
const pointer = { x: 0, y: 0, showKnife: false };
const rayOrigin = new THREE.Vector3();
const rayDirection = new THREE.Vector3();
const stroke = {
	active: false,
	id: 0,
	pointerId: -1,
	x: 0,
	y: 0,
	startX: 0,
	startY: 0,
	travel: 0,
	direction: new THREE.Vector3(0, -1, 0),
	contacts: new Map()
};
let knifeHasPosition = false;

function pointerRay(clientX, clientY, origin, direction) {
	origin.copy(camera.position);
	direction.set(
		clientX / window.innerWidth * 2 - 1,
		1 - clientY / window.innerHeight * 2,
		0.5
	).unproject(camera).sub(origin).normalize();
}

function updateCameraAxes() {
	camera.updateMatrixWorld();
	camera.getWorldDirection(viewDirection);
	screenRight.crossVectors(viewDirection, camera.up).normalize();
	screenUp.crossVectors(screenRight, viewDirection);
	screenDown.copy(screenUp).negate();
}

function updateKnife(delta) {
	knife.visible = pointer.showKnife;

	if (!pointer.showKnife) {
		knifeHasPosition = false;

		return;
	}

	// Hold the knife at the depth of the jelly, under the pointer
	focusPlane.setFromNormalAndCoplanarPoint(viewDirection, controls.target);
	pointerRay(pointer.x, pointer.y, rayOrigin, rayDirection);

	const distance = -focusPlane.distanceToPoint(rayOrigin) / focusPlane.normal.dot(rayDirection);

	knifeTarget.copy(rayOrigin).addScaledVector(rayDirection, distance);

	if (!knifeHasPosition) {
		knife.position.copy(knifeTarget);
		knifeHasPosition = true;
	}

	knife.position.lerp(knifeTarget, 1 - Math.exp(-40 * delta));

	// The edge faces the motion and the blade points into the screen,
	// so the knife looks held from the viewer's side, handle in front
	strokeDirection.lerp(stroke.active ? stroke.direction : screenDown, 1 - Math.exp(-16 * delta));
	strokeDirection.addScaledVector(viewDirection, -strokeDirection.dot(viewDirection));

	if (strokeDirection.lengthSq() < 1e-4) strokeDirection.copy(screenDown);

	strokeDirection.normalize();
	bladeAcross.crossVectors(viewDirection, strokeDirection).normalize();

	if (bladeAcross.dot(screenRight) - bladeAcross.dot(screenUp) > 0) bladeAcross.negate();

	bladeAxis.copy(viewDirection).multiplyScalar(0.55).addScaledVector(bladeAcross, 0.84).normalize();
	bladeSpine.copy(strokeDirection).negate();
	bladeSide.crossVectors(bladeAxis, bladeSpine).normalize();
	knifeBasis.makeBasis(bladeAxis, bladeSpine, bladeSide);
	knifeQuaternion.setFromRotationMatrix(knifeBasis);
	knife.quaternion.slerp(knifeQuaternion, 1 - Math.exp(-20 * delta));
}

// 13. Slice with the pointer: the line drawn on the screen defines the cut
const sampleOrigin = new THREE.Vector3();
const sampleDirection = new THREE.Vector3();
const firstDirection = new THREE.Vector3();
const cutNormal = new THREE.Vector3();
const strokeMotion = new THREE.Vector3();
const bladePush = new THREE.Vector3();
const hint = document.getElementById('hint');

// Ray against the rendered triangles of a piece; returns the hit distance or -1
function rayHitPiece(piece, origin, direction) {
	const ox = origin.x;
	const oy = origin.y;
	const oz = origin.z;
	const dx = direction.x;
	const dy = direction.y;
	const dz = direction.z;
	let near = 0;
	let far = Infinity;

	for (let c = 0; c < 3; c++) {
		const o = c === 0 ? ox : c === 1 ? oy : oz;
		const e = c === 0 ? dx : c === 1 ? dy : dz;
		const low = (piece.min[c] - 0.05 - o) / e;
		const high = (piece.max[c] + 0.05 - o) / e;

		near = Math.max(near, Math.min(low, high));
		far = Math.min(far, Math.max(low, high));
	}

	if (near > far) return -1;

	const { world, index } = piece.flesh;
	let closest = -1;

	for (let t = 0; t < index.length; t += 3) {
		const a = index[t] * 3;
		const b = index[t + 1] * 3;
		const c = index[t + 2] * 3;
		const e1x = world[b] - world[a];
		const e1y = world[b + 1] - world[a + 1];
		const e1z = world[b + 2] - world[a + 2];
		const e2x = world[c] - world[a];
		const e2y = world[c + 1] - world[a + 1];
		const e2z = world[c + 2] - world[a + 2];
		const px = dy * e2z - dz * e2y;
		const py = dz * e2x - dx * e2z;
		const pz = dx * e2y - dy * e2x;
		const determinant = e1x * px + e1y * py + e1z * pz;

		// Front faces only: a closed surface has one on every line through it
		if (determinant < 1e-10) continue;

		const inverse = 1 / determinant;
		const tx = ox - world[a];
		const ty = oy - world[a + 1];
		const tz = oz - world[a + 2];
		const u = (tx * px + ty * py + tz * pz) * inverse;

		if (u < 0 || u > 1) continue;

		const qx = ty * e1z - tz * e1y;
		const qy = tz * e1x - tx * e1z;
		const qz = tx * e1y - ty * e1x;
		const v = (dx * qx + dy * qy + dz * qz) * inverse;

		if (v < 0 || u + v > 1) continue;

		const hit = (e2x * qx + e2y * qy + e2z * qz) * inverse;

		if (hit > 0 && (closest < 0 || hit < closest)) closest = hit;
	}

	return closest;
}

// Push the jelly around a line through the scene, with a smooth falloff
function pushAlongRay(piece, origin, direction, radius, vx, vy, vz) {
	const { x, v, nodeCount } = piece;

	for (let i = 0; i < nodeCount; i++) {
		const i3 = i * 3;
		const px = x[i3] - origin.x;
		const py = x[i3 + 1] - origin.y;
		const pz = x[i3 + 2] - origin.z;
		const along = px * direction.x + py * direction.y + pz * direction.z;
		const qx = px - direction.x * along;
		const qy = py - direction.y * along;
		const qz = pz - direction.z * along;
		const distance = Math.hypot(qx, qy, qz);

		if (distance >= radius) continue;

		const falloff = (1 - distance / radius) ** 2;

		v[i3] += vx * falloff;
		v[i3 + 1] += vy * falloff;
		v[i3 + 2] += vz * falloff;
	}
}

function applyCut(piece, contact, endX, endY) {
	if (Math.hypot(endX - contact.x, endY - contact.y) < MIN_CUT_PIXELS) return false;

	pointerRay(contact.x, contact.y, sampleOrigin, firstDirection);
	pointerRay(endX, endY, sampleOrigin, sampleDirection);
	cutNormal.crossVectors(firstDirection, sampleDirection);

	if (cutNormal.lengthSq() < 1e-10) return false;

	cutNormal.normalize();

	return cutPiece(piece, cutNormal.x, cutNormal.y, cutNormal.z, cutNormal.dot(sampleOrigin), stroke.id);
}

function advanceStroke(toX, toY) {
	const fromX = stroke.x;
	const fromY = stroke.y;
	const pixels = Math.hypot(toX - fromX, toY - fromY);
	const steps = Math.min(48, Math.max(1, Math.ceil(pixels / STROKE_SAMPLE_PIXELS)));

	// Convert the motion of the pointer into a motion of the blade in the scene
	const worldPerPixel = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.distanceTo(controls.target) / window.innerHeight;

	strokeMotion.copy(screenRight).multiplyScalar((toX - fromX) * worldPerPixel).addScaledVector(screenUp, (fromY - toY) * worldPerPixel);

	if (strokeMotion.lengthSq() > 1e-8) stroke.direction.copy(strokeMotion).normalize();

	bladePush.copy(strokeMotion).multiplyScalar(1.1 / steps).clampLength(0, 1.2);

	for (let step = 1; step <= steps; step++) {
		const sampleX = fromX + (toX - fromX) * step / steps;
		const sampleY = fromY + (toY - fromY) * step / steps;

		for (const piece of [...pieces]) {
			if (piece.immuneStroke === stroke.id) continue;

			pointerRay(sampleX, sampleY, sampleOrigin, sampleDirection);

			const hit = rayHitPiece(piece, sampleOrigin, sampleDirection) >= 0;
			const contact = stroke.contacts.get(piece);

			if (hit) {
				if (contact) {
					contact.lastX = sampleX;
					contact.lastY = sampleY;
				} else {
					stroke.contacts.set(piece, { x: sampleX, y: sampleY, lastX: sampleX, lastY: sampleY });
				}

				// The blade drags the jelly with it on its way through
				pushAlongRay(piece, sampleOrigin, sampleDirection, 0.42, bladePush.x, bladePush.y, bladePush.z);
			} else if (contact) {
				stroke.contacts.delete(piece);
				applyCut(piece, contact, sampleX, sampleY);
			}
		}
	}

	stroke.travel += pixels;
	stroke.x = toX;
	stroke.y = toY;
}

function finishStroke(x, y) {
	advanceStroke(x, y);

	const isClick = stroke.travel < CLICK_PIXELS;

	if (isClick) {
		// A click pokes the closest piece with the tip of the knife
		pointerRay(x, y, sampleOrigin, sampleDirection);

		let target = null;
		let closest = Infinity;

		for (const piece of pieces) {
			const hit = rayHitPiece(piece, sampleOrigin, sampleDirection);

			if (hit >= 0 && hit < closest) {
				closest = hit;
				target = piece;
			}
		}

		if (target) {
			pushAlongRay(
				target,
				sampleOrigin,
				sampleDirection,
				0.65,
				sampleDirection.x * 3.5,
				sampleDirection.y * 3.5,
				sampleDirection.z * 3.5
			);
		}
	} else {
		for (const [piece, contact] of [...stroke.contacts]) {
			applyCut(piece, contact, contact.lastX, contact.lastY);
		}
	}

	stroke.contacts.clear();
	stroke.active = false;
	stroke.pointerId = -1;
}

renderer.domElement.addEventListener('pointerdown', (event) => {
	// A second finger means the user wants to move the camera
	if (stroke.active) {
		if (event.pointerType === 'touch') {
			stroke.contacts.clear();
			stroke.active = false;
			stroke.pointerId = -1;
			pointer.showKnife = false;
		}

		return;
	}

	if (event.button !== 0) return;

	pointer.x = event.clientX;
	pointer.y = event.clientY;
	pointer.showKnife = true;
	stroke.active = true;
	stroke.id++;
	stroke.pointerId = event.pointerId;
	stroke.x = stroke.startX = event.clientX;
	stroke.y = stroke.startY = event.clientY;
	stroke.travel = 0;
	stroke.contacts.clear();
	trail.length = 0;
	addTrailPoint(event.clientX, event.clientY);
	updateCameraAxes();
	advanceStroke(event.clientX, event.clientY);
	hint.classList.add('hidden');
});

window.addEventListener('pointermove', (event) => {
	if (stroke.active && event.pointerId !== stroke.pointerId) return;

	if (event.pointerType === 'mouse') {
		pointer.showKnife = true;
		pointer.x = event.clientX;
		pointer.y = event.clientY;
	}

	if (stroke.active) {
		pointer.x = event.clientX;
		pointer.y = event.clientY;
		addTrailPoint(event.clientX, event.clientY);
		updateCameraAxes();
		advanceStroke(event.clientX, event.clientY);
	}
});

function endStroke(event) {
	if (!stroke.active || event.pointerId !== stroke.pointerId) return;

	updateCameraAxes();
	finishStroke(event.clientX, event.clientY);

	if (event.pointerType !== 'mouse') pointer.showKnife = false;
}

window.addEventListener('pointerup', endStroke);
window.addEventListener('pointercancel', endStroke);

document.documentElement.addEventListener('pointerleave', (event) => {
	if (event.pointerType === 'mouse' && !stroke.active) pointer.showKnife = false;
});

document.getElementById('reset').addEventListener('click', resetSlice);

// A light line shows the path of the blade
const trailCanvas = document.getElementById('trail');
const trailContext = trailCanvas.getContext('2d');
const trail = [];
const TRAIL_LIFETIME = 0.28;
let trailDrawn = false;

function addTrailPoint(x, y) {
	trail.push({ x, y, age: 0 });
}

function resizeTrail() {
	const ratio = Math.min(window.devicePixelRatio, 2);

	trailCanvas.width = window.innerWidth * ratio;
	trailCanvas.height = window.innerHeight * ratio;
	trailContext.setTransform(ratio, 0, 0, ratio, 0, 0);
}

resizeTrail();

function updateTrail(delta) {
	for (const point of trail) point.age += delta;

	while (trail.length > 0 && trail[0].age > TRAIL_LIFETIME) trail.shift();

	if (trail.length === 0 && !trailDrawn) return;

	trailContext.clearRect(0, 0, window.innerWidth, window.innerHeight);
	trailContext.lineCap = 'round';
	trailDrawn = trail.length > 1;

	for (let i = 1; i < trail.length; i++) {
		const life = 1 - trail[i].age / TRAIL_LIFETIME;

		trailContext.strokeStyle = `rgba(120, 128, 140, ${0.5 * life})`;
		trailContext.lineWidth = 0.5 + 2.5 * life;
		trailContext.beginPath();
		trailContext.moveTo(trail[i - 1].x, trail[i - 1].y);
		trailContext.lineTo(trail[i].x, trail[i].y);
		trailContext.stroke();
	}
}

// 14. Add camera control: the left button belongs to the knife
const controls = new OrbitControls(camera, renderer.domElement);

controls.target.set(0, 0.95, 0);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2 - 0.03;
controls.minDistance = 3;
controls.maxDistance = 18;
controls.mouseButtons = {
	LEFT: null,
	MIDDLE: THREE.MOUSE.PAN,
	RIGHT: THREE.MOUSE.ROTATE
};
controls.touches = {
	ONE: null,
	TWO: THREE.TOUCH.DOLLY_ROTATE
};
controls.update();

renderer.domElement.style.cursor = 'none';

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

	if (event.key === 'r' || event.key === 'R') resetSlice();
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

// 15. AnimationLoop
let previousTime = performance.now();
let accumulator = 0;

function animate(time) {
	const delta = Math.min((time - previousTime) / 1000, MAX_FRAME_TIME);

	previousTime = time;
	accumulator += delta;

	updateContactPairs();

	// Fixed physics steps keep the jelly identical at every screen frequency
	while (accumulator >= SUBSTEP) {
		stepPhysics();
		accumulator -= SUBSTEP;
	}

	for (const piece of pieces) piece.updateSurfaces();

	updateKeyboardControls(delta);
	controls.update();
	updateCameraAxes();
	updateKnife(delta);
	updateTrail(delta);

	renderer.render(scene, camera);
}

renderer.setAnimationLoop(animate);

// 16. Handle browser resizing
window.addEventListener('resize', () => {
	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();

	renderer.setSize(window.innerWidth, window.innerHeight);
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
	resizeTrail();
});
