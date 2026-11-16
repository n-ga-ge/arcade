# About n-ga.ge

n-ga.ge is a collection of games for the Nokia N-Gage, the phone and game deck
from 2003, that you can play in a web browser. There is nothing to install:
pick a game on the front page and it starts in the page.

- [Playing](playing.md): what you need, the controls, saves and display options.
- [Legal](legal.md): licences, and who the games belong to.

## How it works

The games are not rewritten or converted. The site runs an emulator: a program
that behaves like the phone, so the original game runs on it as it did on the
real device. The emulator is [EKA2L1](https://github.com/EKA2L1/EKA2L1), an
open-source Symbian emulator, built here to run inside a web page.

Everything happens on your own device. The game is downloaded once, runs in
your browser, and keeps its saves in your browser. Nothing you do in a game is
sent anywhere.

Emulation is demanding. A recent computer runs most games at their original
speed; older computers and phones may be slow.

## What the labels on the games mean

Not every game works yet. Each game on the front page carries a label that
says how far it gets. A game appears there once it has been tried:

| Label | Meaning |
|---|---|
| Playable | You can get into the game and play. |
| Menus only | The menus work, but the game itself does not start or cannot be played. |
| Boots | The game shows its opening screens and goes no further. |
| Not working | The game does not start. |

The games are also started automatically by a test every time the site
changes, and the card shows whether that test passed. A game can be listed as
playable and still have faults in places the test does not reach.

## Source code

The site and the emulator port are open source. The code, and the technical
documentation that goes with it, are in the project's repositories:

- [the site, its catalogue and tools](https://github.com/n-ga.ge/arcade)
- [the emulator port](https://github.com/n-ga.ge/EKA2L1)
