# 🥒 Cucumber Town

A little Brookhaven-style 3D town you can play in a web browser with your friends.
Walk around, go inside the houses, sit on chairs, sleep in beds, drive the cars,
swim in the pond, and chat — all in real time.

**▶ Play: https://YOUR-USERNAME.github.io/cucumber-town/**

(replace `YOUR-USERNAME` with your GitHub username once Pages is switched on)

## How to play with friends

1. Everyone opens the link above.
2. Type your name and pick a shirt colour.
3. **Everyone types the same room code** — that's what puts you in the same town.
4. Press Play. You should see each other walking around.

## Controls

| Key | What it does |
| --- | --- |
| `W` `A` `S` `D` or arrow keys | Walk |
| `Shift` | Run |
| `Space` | Jump |
| `E` | Sit / sleep / get in a car |
| Drag the mouse | Look around |
| Mouse wheel | Zoom in and out |
| `Enter` | Chat |

Walk into a house and the roof lifts off so you can see the whole room.
Walk into the pond and you start swimming. Press `E` next to a car to drive it
(`W`/`S` to go and reverse, `A`/`D` to steer).

## How it works

- 3D graphics: [three.js](https://threejs.org)
- Multiplayer: [Trystero](https://github.com/dmotz/trystero) — peer to peer, so
  there is **no server to run and nothing to pay for**. Players connect directly
  to each other, and the room code decides who is in which world.
- The whole game is one self-contained `index.html` file (~600 KB) with
  everything already inside it.

## Editing the game

The playable file `index.html` is built from the source in `src/`:

```bash
npm install three trystero esbuild
npx esbuild src/game.js --bundle --minify --format=iife --outfile=bundle.js
node -e "const f=require('fs');f.writeFileSync('index.html',f.readFileSync('src/index.template.html','utf8').replace('/*__BUNDLE__*/',()=>f.readFileSync('bundle.js','utf8')))"
```

- `src/game.js` — the town, the characters, the driving, the multiplayer
- `src/index.template.html` — the start screen, the buttons and the on-screen text

Add `?test=1` to the URL to load straight into the game without the start screen.

## Ideas for next time

Pets, day and night, a money system, more furniture, car horns, touch controls
for phones and tablets.
