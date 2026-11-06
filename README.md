# Simple Three.js Project

A minimal 3D scene built with [Three.js](https://threejs.org/) and [Vite](https://vite.dev/): a rotating purple cube, displayed fullscreen, that you can view from any angle with your mouse.

## Getting started

This project uses [pnpm](https://pnpm.io/). Install the dependencies, then start the development server:

```bash
pnpm install
pnpm dev
```

Then open the address shown in your terminal.

## Commands

```bash
pnpm dev      # Start the development server
pnpm build    # Build for production into dist/
pnpm preview  # Serve the production build locally
```

## Controls

| Action | Mouse | Touch | Keyboard |
| --- | --- | --- | --- |
| Orbit around the cube | Left-click + drag | Drag with one finger | Arrow keys |
| Zoom in or out | Scroll wheel | Pinch with two fingers | – |
| Pan the view | Right-click + drag | Drag with two fingers | – |

## Project structure

```text
├── index.html       # Page entry point
├── public/          # Static files served from the root (favicon)
└── src/
    ├── main.js      # Scene, camera, lights, controls and animation
    └── style.css    # Page styles, imported by main.js
```

## License

This project is licensed under the [ISC License](LICENSE).
