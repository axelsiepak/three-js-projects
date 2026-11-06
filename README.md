# Three.js Projects

A library of small 3D projects built with [Three.js](https://threejs.org/) and [Vite](https://vite.dev/).

## Projects

| Demo | Project | Description |
| --- | --- | --- |
| <img src="projects/particle-galaxy/demo.gif" alt="A spiral galaxy slowly rotating around its bright core" width="240"> | [Particle Galaxy](projects/particle-galaxy/) | A spiral galaxy made of 60,000 particles |
| <img src="projects/rotating-cube/demo.gif" alt="The cube rotating while the camera orbits around it" width="240"> | [Rotating Cube](projects/rotating-cube/) | A rotating purple cube you can view from any angle |

## Getting started

This project uses [pnpm](https://pnpm.io/). Install the dependencies, then start the development server:

```bash
pnpm install
pnpm dev
```

Then open the address shown in your terminal: the home page lists every project.

## Commands

```bash
pnpm dev      # Start the development server
pnpm build    # Build the home page and every project into dist/
pnpm preview  # Serve the production build locally
```

## Adding a project

Copy an existing project, then change the `<title>` in its `index.html`:

```bash
cp -r projects/rotating-cube projects/my-project
```

The folder name becomes the project's URL and the `<title>` is its name on the home page. Any folder in `projects/` with an `index.html` is picked up automatically.

The home page also shows the project's `demo.gif` if it has one, so replace or delete the copied GIF.

## Project structure

```text
├── index.html           # Home page listing the projects
├── vite.config.js       # Finds the projects and fills in the home page
├── public/              # Static files served from the root (favicon)
└── projects/
    └── rotating-cube/
        ├── index.html   # Project entry point
        ├── README.md    # Project description and controls
        ├── demo.gif     # Optional animation shown on the home page and in the READMEs
        └── src/         # Project code and styles
```

## License

This project is licensed under the [ISC License](LICENSE).
