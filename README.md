# Three.js Simple Projet

Une scène 3D minimale réalisée avec [Three.js](https://threejs.org/) et [Vite] : un cube violet en rotation, affiché en plein écran, que l'on peut observer sous tous les angles à la souris.

[Vite]: https://vite.dev/

## Démarrage

Le projet utilise [pnpm](https://pnpm.io/). Installez les dépendances, puis lancez le serveur de développement :

```bash
pnpm install
pnpm dev
```

Ouvrez ensuite l'adresse affichée dans le terminal.

## Commandes

| Commande | Description |
| --- | --- |
| `pnpm dev` | Lance le serveur de développement |
| `pnpm build` | Génère le build de production dans `dist/` |
| `pnpm preview` | Sert le build de production en local |

## Contrôles

| Effet | Souris | Tactile |
| --- | --- | --- |
| Tourner autour du cube | Clic gauche + glisser | Glisser un doigt |
| Zoomer ou dézoomer | Molette | Pincer avec deux doigts |
| Déplacer la vue | Clic droit + glisser | Glisser deux doigts |

## Structure

```text
├── index.html       # Point d'entrée de la page
├── public/          # Fichiers statiques servis à la racine (favicon)
└── src/
    ├── main.js      # Scène, caméra, lumières, contrôles et animation
    └── style.css    # Styles de la page, importés par main.js
```

## Licence

Ce projet est distribué sous licence [ISC](LICENSE).
