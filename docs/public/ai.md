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

From 2026-11-16 to 2026-11-18, in 85 conversations with the agents:

| Model | Requests | Input tokens | Cache writes | Cache reads | Output tokens | At API prices |
|---|---:|---:|---:|---:|---:|---:|
| Claude Fable 5.2 | 9,450 | 19,484 | 26,249,722 | 2,132,303,493 | 9,719,822 | $1,211 |
| Claude Opus 5.5 | 3,243 | 6,558 | 9,924,159 | 843,374,992 | 2,183,406 | $282 |
| Claude Sonnet 5.5 | 6 | 18 | 32,793 | 303,181 | 4,532 | $0 |
| **Total** | 12,699 | 26,060 | 36,206,674 | 2,975,981,666 | 11,907,760 | $1,493 |

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
of conversations. Figures as of 2026-11-18.
