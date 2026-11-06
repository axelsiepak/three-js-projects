import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const root = import.meta.dirname;
const projectsDir = resolve(root, 'projects');

function findProjects() {
	return readdirSync(projectsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => ({
			name: entry.name,
			html: resolve(projectsDir, entry.name, 'index.html')
		}))
		.filter((project) => existsSync(project.html))
		.map((project) => ({
			...project,
			title: readFileSync(project.html, 'utf8').match(/<title>(.*?)<\/title>/)?.[1] ?? project.name,
			hasDemo: existsSync(resolve(projectsDir, project.name, 'demo.gif'))
		}));
}

const projectGallery = {
	name: 'project-gallery',
	transformIndexHtml: {
		order: 'pre',
		handler: (html) => html.replace(
			'<!-- projects -->',
			findProjects()
				.map(({ name, title, hasDemo }) => {
					const demo = hasDemo ? `<img src="projects/${name}/demo.gif" alt="" loading="lazy">` : '';

					return `<li><a href="projects/${name}/">${demo}<span>${title}</span></a></li>`;
				})
				.join('\n')
		)
	}
};

export default defineConfig({
	appType: 'mpa',
	plugins: [projectGallery],
	build: {
		rolldownOptions: {
			input: {
				main: resolve(root, 'index.html'),
				...Object.fromEntries(findProjects().map(({ name, html }) => [name, html]))
			}
		}
	}
});
