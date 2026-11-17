# Made with AI

The code of this site was written by AI models, working as coding agents
under the direction of a person, who decided what to build and steered the
work. That covers the port of the emulator to the browser, the player, the
front page, the catalogue of games and their tests, the tools, and this
documentation.

The emulator itself, [EKA2L1](https://github.com/EKA2L1/EKA2L1), is the work
of its own developers over many years; the port changes it as little as
possible. The games are the original ones, unchanged. Nothing on the site uses
AI while you play: the emulator runs the game, and nothing is sent anywhere.

## Models used

All the work was done with [Claude Code](https://claude.com/claude-code),
Anthropic's coding agent, with these models:

- **Claude Fable 5.2** did nearly all of it, including the agents that worked
  in parallel on separate games and parts of the site.
- **Claude Opus 5.5** did a smaller share of the later work.

No other AI models or services were used.

## Tokens and cost

From 2026-11-16 to 2026-11-17, in 36 conversations with the agents:

| Model | Requests | Input tokens | Cache writes | Cache reads | Output tokens | At API prices |
|---|---:|---:|---:|---:|---:|---:|
| Claude Fable 5.2 | 4,865 | 10,206 | 15,577,350 | 1,263,310,204 | 5,529,173 | $707 |
| Claude Opus 5.5 | 398 | 800 | 1,407,024 | 43,255,517 | 269,850 | $21 |
| **Total** | 5,263 | 11,006 | 16,984,374 | 1,306,565,721 | 5,799,023 | $728 |

A request is one reply from the model, and an agent makes hundreds of
them in a task. Each request sends the conversation so far. Most of it
the model has seen before and reads back from a cache, at a small part
of the price (cache reads); what is new is written to that cache (cache
writes) or sent as plain input. Output tokens include the model's
reasoning, not only the code and text it wrote.

The last column is what these tokens cost at Anthropic's API prices of
November 2026. The work ran on a flat-rate Claude subscription, so
there was no bill per token: the figure says how much computing the
work took, not what was paid.

Counted by [a script](../../tools/ai/usage.py) from the transcripts the
agents keep of every conversation. It does not see the few small
requests the tools make without writing them down, such as the titles
of conversations. Figures as of 2026-11-17.
