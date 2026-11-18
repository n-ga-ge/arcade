# n-ga.ge

The source of [n-ga.ge](https://n-ga.ge): a Nokia N-Gage emulator that runs in
the browser, with a catalogue of games that are each tested automatically.

The emulator is a WebAssembly port of [EKA2L1](https://github.com/EKA2L1/EKA2L1),
kept in its own repository, [n-ga-ge/EKA2L1](https://github.com/n-ga-ge/EKA2L1)
(branch `web-port`), and included here as the submodule `eka2l1/`. This
repository holds the rest: the catalogue (`catalog/`), the front page
(`site/`), the site build and the test tools (`tools/`), the Cloudflare
Workers that serve the game files and the multiplayer rooms (`cloudflare/`),
and the visitors' documentation (`docs/public/`, published at
[n-ga.ge/docs](https://n-ga.ge/docs/)).

No firmware and no games are included, here or in the emulator's repository:
they are copyrighted and are not distributed.

## About this copy

This repository is a read-only copy of the project's own, updated
automatically. It carries the source code only. Every commit has the same
author, "n-ga.ge contributors", and its time in UTC. Changes made here are not
merged back.

## Licence

GPL-3.0, like EKA2L1. See [LICENSE](LICENSE).
