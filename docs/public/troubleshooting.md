# Troubleshooting

A game that is slow, silent or stops has a cause, and most of the time the
cause is on the device it is played on. The player can measure that device
while you play and tell you what it found. This page explains each thing it
can find: what it means, why it happens and what you can try.

## Finding out what is wrong

1. Start the game and play for half a minute. Do what is slow or broken, if
   you can: the player measures the last 30 seconds of play, and a pause
   starts the measuring again.
2. Open **Menu → Diagnostics**.
3. Read the top of the dialog. It lists what was found, the most serious
   first: what is wrong, the numbers behind it, and what to do. **More about
   this** under a finding opens its section of this page.

Below the findings the dialog shows what it measured, part by part. It keeps
measuring while it is open, so you can leave it open and watch.

"Nothing wrong was found" means that nothing the player can measure explains
the trouble. The fault may then be in the game or in the emulator, not on
your device: see the label of the game on the front page
([what the labels mean](index.md#what-the-labels-on-the-games-mean)), and
send a report.

Some causes have no cure. The emulator has to act out every step of the
phone's processor, which takes a fast processor, and no setting makes that
cheaper. Where that is the answer, this page says so.

## Sending a report

A report is what the dialog shows, in a form you can pass on. It helps the
people who work on the site see what happened on a device they cannot look
at.

- **Copy report** puts it on the clipboard as text, to paste into a message.
- **Download report** saves it as a file, to attach.

Nothing is sent by itself. The player sends nothing about you or your device
anywhere: a report leaves your browser only when you copy or download it and
send it yourself.

The report describes the game, the browser and the device, not you: which
game ran, what was found, the measurements, and what the browser says about
itself and the device, such as its version, the number of processor cores and
the name of the graphics card. Your saves are not in it. It is plain text:
read it before you send it, and take out anything you would rather keep to
yourself.

The site has no form and no address for reports. They are read where the
project is developed: open an issue in
[the project's repository](https://github.com/n-ga-ge/arcade) and paste the
report or attach the file. Say which game it was, what you did, and what
happened. An issue there is public: anyone can read what you post.

## The game is slow

### This device is too slow for the game

The emulator worked without a break and the game still fell behind. The
processor of this device is not fast enough for this game.

A game for the N-Gage was made for the phone's processor. The emulator acts
out every step of that processor, one after the other, and that work cannot
be shared out between several cores: its speed is the speed of one core.
A recent computer manages it. An older one, and most phones and tablets, may
not.

What to try:

- Close other tabs and programs that keep the processor busy.
- On a laptop, plug in the charger and switch off any power saving mode.
  Many laptops slow their processor down on battery.
- Try another game. Some ask for much less than others.
- Play on a faster device if you have one.

There is no setting that makes the emulator faster, and the display options
make no difference here. If none of this helps, the device is too slow for
this game, and that cannot be cured.

*In a report: `cpu-bound`*

### The processor is slower than the emulator needs

**Test this device** in the dialog measured how fast this processor does the
kind of work the emulator does, and the result is below what a game needs.
Lighter games may still run well. Heavy ones will be slow.

The test compares your device with the computer the site is developed on,
which runs a demanding game at its own speed with little to spare.

What to try:

- Run the test again with other tabs and programs closed. Anything else that
  uses the processor lowers the result.
- On a laptop, plug in the charger and switch off any power saving mode.
- Play on a faster device if you have one.

A processor that is too slow cannot be made faster from here.

*In a report: `device-slow`*

### The processor has too few cores

The emulator does several things at the same time: it runs the game, draws
the picture, prepares the sound and keeps the page going. This device has
fewer processor cores than that, so these take turns, and the game and its
sound wait for each other.

What to try:

- Close other tabs and programs, so that the cores there are go to the game.
- Mute the sound (**Menu → Mute**) if the game matters more to you than its
  sound.

The number of cores is a property of the device. Some browsers and privacy
settings report fewer cores than the device has, and then this finding can
be wrong.

*In a report: `few-cores`*

### Something else is using the processor

The emulator had time to spare, and its clocks still ran late. It was not
given the processor at the moments it needed it. That is not a device too
slow for the game: it is a device busy with something else.

What to try:

- Close other tabs, above all ones that play video or run games.
- Close other programs that are working: downloads, updates, a virus scan,
  a video call.
- On a laptop, plug in the charger and switch off any power saving mode.
- Wait a minute and look again. A computer that has just started, or a
  browser that has just opened, is busy for a while.

*In a report: `timers-late`*

### The game runs at its own speed

Nothing is wrong. The game draws as many pictures a second as it wants to,
and the emulator keeps up with time to spare.

Many N-Gage games draw far fewer pictures a second than a game of today. The
Elder Scrolls Travels: Shadowkey, for one, draws about 20 and no more. Games
also draw only when something on the screen changes, so a still menu counts
close to nothing. On the phone it was the same.

There is nothing to try: a faster device would not make the game any
smoother.

*In a report: `game-limited`*

### The page keeps getting held up

The page itself stood still for moments at a time. The game runs beside the
page and goes on, but your key presses pass through the page, so they can
arrive late, and the sound can start late.

The usual causes are in the browser: an extension that works on every page,
the browser's developer tools left open, or other tabs keeping the browser
busy.

What to try:

- Close other tabs.
- Close the browser's developer tools if they are open.
- Switch off extensions for this site, or try a window without them. Mind
  that a private window does not keep your saves: see
  [saves will not be kept](#saves-will-not-be-kept).

*In a report: `main-thread-stalls`*

### The page was in the background

While the player measured, the page was not in view for part of the time:
you were on another tab, or the window was minimised or covered. The numbers
in the dialog are therefore not those of normal play.

The game pauses by itself when its tab is not in view, except while you play
with someone else. Nothing is wrong with that.

What to try:

- Keep the tab in view, play for half a minute, and look at the diagnostics
  again.

*In a report: `tab-was-hidden`*

## The picture

### The browser draws without the graphics card

The browser is drawing the game's picture with the processor, not with the
graphics card. It works, but it takes processor time that the game needs,
and enlarging the picture with a filter becomes expensive.

A browser does this when its hardware acceleration is switched off, when it
does not trust the graphics driver, or when there is no graphics card it can
use, as in a virtual machine or over a remote desktop.

What to try:

- Switch on hardware acceleration in the browser's settings (in Chrome and
  Edge it is under **System**), and restart the browser.
- Update the graphics driver, or the operating system where it brings the
  driver.
- Until then, make the picture cheap: in **Menu → Display** choose
  **Sharp pixels** or **Smooth** for the scaling, a low resolution such as
  **1× native** or **2× native**, and **Original shape** for filling the
  screen.
- Try another browser. They do not all distrust the same drivers.

*In a report: `software-rendering`*

### Drawing the picture takes too long

The game had its picture ready and had to wait until the last one was drawn.
The picture is what holds the game back, not the game itself.

The game's own picture is small and cheap. What costs is enlarging it for
your screen: some filters take many times the work of the plain ones, more
so at a high resolution and on a weak graphics card.

What to try, in **Menu → Display**:

- Choose **Sharp pixels** or **Smooth** for the scaling.
- Lower the resolution to **2× native** or **1× native**.
- Set **Fill the screen** to **Original shape**.

If the dialog also says that the browser draws without the graphics card,
deal with that first: see
[above](#the-browser-draws-without-the-graphics-card).

*In a report: `graphics-bound`*

### The browser is not showing the page

The browser has stopped drawing this page, which it does when the tab is in
the background or the window is minimised or covered. The game cannot show
its picture then.

Alone, the game pauses until you come back. While you play with someone
else it goes on without being shown, so that the other player's game is not
left waiting, and you do not see what happens in it meanwhile.

What to try:

- Bring the tab to the front and keep the window in view.
- If the window is in view and the dialog still says this, something is
  covering the page or the browser is saving power. Move the window to
  another screen, or switch off the browser's power saving.

*In a report: `no-animation-frames`*

### The browser took the picture away

The browser stopped the page's access to the graphics card, and the game's
picture stands still or is gone. The game may still be running behind it.

This happens when the graphics driver restarts, when the computer wakes
from sleep, or when the browser runs short of graphics memory because many
tabs use it.

What to try:

- Load the page again. What the game had saved is still there.
- Close other tabs that show video, 3D or games.
- If it keeps happening, update the graphics driver.

*In a report: `context-lost`*

## Sound

### The sound has gaps

The sound ran dry while it was playing: for a moment there was nothing to
play, and you hear a click or a short silence.

The sound is made by the game as it runs. When the game falls behind, so
does its sound. Gaps therefore come together with a game that is slow, and
the cause is usually the one named by another finding in the dialog.

What to try:

- Look at the other findings first, and do what they say.
- Close other tabs and programs.
- If the game matters more than its sound, mute it (**Menu → Mute**).

*In a report: `audio-underruns`*

### The sound has not started yet

Nothing is wrong. A browser does not let a page play sound until you have
clicked, tapped or pressed a key on it.

What to try:

- Click the page or press a key once.
- If there is still no sound, check that the menu does not say **Unmute**,
  that the tab is not muted in the browser (right-click the tab), and that
  the browser allows this site to play sound.

*In a report: `audio-suspended`*

### This browser cannot play the sound

The browser lacks what the player needs to play sound, or it could not open
the device's sound output. The game runs, silently.

What to try:

- Use a current Chrome, Edge or Firefox.
- Check that the device has a working sound output: that other pages play
  sound, and that speakers or headphones are connected and chosen.
- Load the page again after that.

*In a report: `audio-unavailable`*

### The sound falls behind

The part of the emulator that prepares the sound is not given its turn on
time. The game itself may be fast enough: the device is busy with too much
at once.

What to try:

- Close other tabs and programs that are working.
- On a laptop, plug in the charger and switch off any power saving mode.
- See [the processor has too few cores](#the-processor-has-too-few-cores)
  if the dialog says that too.

*In a report: `mixer-starved`*

## The game stops

### The game crashed

The game ran into an error and was stopped. On a real N-Gage the phone would
have closed it too.

The cause is almost always a fault in the emulator, something it does
differently from the phone, and not your device. Some games are known to
crash at certain places: **Details** on the game's card on the front page
and **Menu → Guide** say what is known.

What to try:

- Start it again with **Menu → Restart game**. If the picture then stays
  still, load the page again.
- If it crashes at the same place every time, that place cannot be played
  for now.
- Send a report. A crash is the most useful thing to report, with a few
  words on what you did just before.

*In a report: `game-crashed`*

### The game closed by itself

The game ended without an error. Many games do this when you choose Exit or
Quit in their own menu, and some do it when they cannot go on.

What to try:

- Start it again with **Menu → Restart game**.
- If you did not ask the game to close and it happens again, send a report
  and say what you did just before.

*In a report: `game-exited`*

### The emulator stopped

Not the game but the emulator itself failed, and nothing runs any more.

This is a fault in the emulator. It can also happen when the browser has
no memory left to give it.

What to try:

- Load the page again. What the game had saved is still there.
- Close other tabs and programs first if the device is short of memory.
- Send a report, taken before you load the page again: it holds what the
  emulator said when it stopped.

*In a report: `emulator-stopped`*

### The page ran into errors

The player's page reported errors of its own. Parts of the page, such as
the menu or the controls, may not work, even if the game runs.

The causes are a fault in the player, a browser the player has not been
tried in, or an extension that changes pages.

What to try:

- Load the page again.
- Update the browser.
- Switch off extensions for this site. Blockers of scripts and
  advertisements are the usual ones.
- If the errors come back, send a report.

*In a report: `page-errors`*

### The game asks for something the emulator cannot do

The game called functions of the phone that the emulator does not have.
Most games do this a few times and work all the same, so this alone does
not mean anything is wrong.

If something in the game is missing or does nothing, such as a menu entry,
this is the likely reason.

There is nothing to try. If a part of the game does not work, send a report
and say which part.

*In a report: `unimplemented-calls`*

## Memory, storage and saves

### The emulator is running out of memory

The emulator has a fixed amount of memory it may use, and it is close to
that limit. If it reaches the limit it stops.

The emulator's memory only ever grows during a visit. What it has taken it
keeps until the page is loaded again.

What to try:

- Save in the game, then load the page again. That starts from an empty
  memory, and your saves are kept.

*In a report: `memory-near-limit`*

### The device has little memory

The device reports less memory than the emulator is comfortable with. The
emulator needs about half a gigabyte for itself, beside what the browser and
everything else on the device use. When memory runs short the device slows
down, or the browser closes the page.

What to try:

- Close other tabs and other programs or apps.
- Load the page again if it has been open for a long time.

Some browsers report less memory than the device has, to tell sites less
about you. Then this finding can be wrong.

*In a report: `low-device-memory`*

### The storage for this site is almost full

The browser gives every site a share of the device's storage. This site
keeps your saves there, and the games you have played so that they start
without being downloaded again. That share is almost used up, or the device
itself is nearly full, and a save may fail to be stored.

What to try:

- Export your saves now, to be safe: **Menu → Saves → Export (.zip)**.
- Free some space on the device.
- The player itself makes room by dropping the games you played longest
  ago. They are downloaded again when you play them, and your saves are not
  touched.

Do not clear this site's data in the browser to make room before you have
exported your saves: that deletes them.

*In a report: `storage-nearly-full`*

### Saves will not be kept

What you save in the game is gone when you close the tab. The dialog names
the reason, which is one of these:

- a private or incognito window, which keeps nothing after it closes;
- a browser without the private file storage the player keeps saves in;
- an address that tells the player to keep nothing (`persist=0`).

What to try:

- Play in a normal window of a current Chrome, Edge or Firefox.
- Take `persist=0` out of the address if it is there.
- If you have already played and want to keep it, export before you close
  the tab: **Menu → Saves → Export (.zip)**. You can import the file again
  later, in any browser.

See [Saves](playing.md#saves) for how saves are kept.

*In a report: `saves-not-kept`*

### Storing the saves takes long

The player stores the phone's memory, which holds your saves, every few
seconds while something has changed, and once more when you leave. On this
device that takes long, so a save made in the game just before the tab is
closed may not be stored in time.

The usual causes are a slow or nearly full disk, or a device busy with
other things.

What to try:

- After saving in the game, wait a few seconds before you close the tab.
- Leave with **Menu → All games**, which waits for the saves.
- Export your saves now and then as a backup:
  **Menu → Saves → Export (.zip)**.

*In a report: `save-slow`*

## Playing with someone else

### The connection to the other players is slow

What your game sends to the other players takes long to get there and back.
The games were made for phones lying next to each other, and expect an
answer almost at once. With a slow connection a game stutters, waits, or
decides the other phone is gone.

Everything passes through the site on its way, so the distance from each of
you to the site counts, as well as your own connections.

What to try:

- Stop what else uses the connection: downloads, video, other devices.
- Use a cable, or move closer to the Wi-Fi.
- Ask the other player to do the same. A slow connection on either side
  slows both.

The distance cannot be changed. Between players far apart, some games may
not hold a connection at all.

*In a report: `relay-slow`*

### The game fell behind the connection

The other players sent more than your game took in, until too much was
waiting. The player then threw it away and ended the game's connections. To
the game it looks as if the other N-Gage went out of range.

It happens when your game stands still or runs too slowly while the others
go on: a tab in the background, a pause, or a device too slow for the game.

What to try:

- Start the multiplayer session again in the game, after entering the room
  again if you had left it.
- Keep the tab in view while you play.
- If the dialog also says the device is too slow for the game, see
  [above](#this-device-is-too-slow-for-the-game).

*In a report: `net-frames-dropped`*

### The multiplayer service cannot be reached

The player could not reach the part of the site that connects the players,
or was turned away by it. The dialog gives the reason.

The causes are a lost internet connection, a network that blocks this kind
of connection (some company, school and hotel networks do), a room that is
full or no longer exists, or the service itself being down.

What to try:

- Check that other sites load.
- Open **Menu → Multiplayer…** and join the room again, or host a new one
  and send the new link.
- Try another network, for example a phone's hotspot.
- Try again later. If it still fails and other sites work, send a report.

See [playing with someone else](playing.md#playing-with-someone-else) for
how rooms work.

*In a report: `relay-unreachable`*

## Starting a game

### The download was slow

Most of the wait before the game started was the download. Nothing is wrong
with the device: the internet connection was slow, or the game is large.

A game is downloaded once. After that it is kept on your device and starts
without downloading again.

What to try:

- Nothing, the next start will be quick.
- If every start downloads again, the browser is not keeping the games: see
  [saves will not be kept](#saves-will-not-be-kept), which has the same
  causes.

*In a report: `slow-download`*

### Starting the game took long

The files were there, and it still took long until the game ran. Between
the download and the first picture the browser prepares the emulator and
the game is put into it, and on this device that is slow. The dialog names
the step that took longest.

It points at the device: a slow processor or a slow disk. A game that takes
long to start is likely to run slowly as well.

What to try:

- Close other tabs and programs, then load the page again.
- On a laptop, plug in the charger and switch off any power saving mode.

*In a report: `slow-start`*

## The browser

### The browser cannot run the emulator

The browser lacks something the emulator cannot do without. The player says
what when it opens, and the dialog lists it. The game does not start.

What to try:

- Use a current Chrome, Edge or Firefox on a computer. Safari has not been
  tried.
- Update the browser if it is one of those.
- Open the site directly, in a tab of its own. Inside another page, or
  through a service that passes pages on (a translator, a proxy), the
  browser withholds things the emulator needs.

See [what you need](playing.md#what-you-need).

*In a report: `browser-unsupported`*
