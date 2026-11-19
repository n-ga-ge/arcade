#!/usr/bin/env python3
"""Install a Nokia phone firmware (a VPL file and its FPSX images) into an EKA2L1 data folder.

  python3 -I tools/devices/install.py --vpl FILE --out DIR [--variant N] [--build DIR]
  python3 -I tools/devices/install.py --mcu FILE [--ppm FILE] [--content FILE] --out DIR [--build DIR]

The fork unpacks a firmware with eka2l1::install_firmware(), which only the
desktop frontend's dialog calls; the control API has no firmware install and
the desktop frontend cannot be built here. So this script compiles
install_firmware.cpp, a small main() around that function, against the
static libraries of an existing web build of the fork and runs it with Node.

The tool is built on demand into tools/devices/out/tool/ (ignored by git), and
built again when the source, the build's build.ninja or any of its libraries
changed. The compile flags, include folders and libraries come from the web
build's own build.ninja (the eka2l1_web target); only the Node settings of the
link are this script's.

  --build DIR   the web build folder (default: eka2l1/build/web of this checkout,
                else of the main checkout); it must have been built
  --vpl FILE    a VPL file; the images it names are looked up beside it
  --mcu, --ppm, --content
                the images themselves; a VPL naming them is written for the run
  --variant N   which variant of the VPL to install (default 0; the variants are listed)
  --tool-dir DIR
                where the tool is built (default tools/devices/out/tool/)
  --out DIR     the data folder; roms/, drives/z/ and drives/c/ are created in it

The result is the data folder as the emulator keeps it: roms/<code>/SYM.ROM,
drives/z/<code>/, the firmware's drive C files in drives/c/, and devices.yml.
tools/devices/pack.py turns it into the zip the player installs.

Firmware is copyrighted: keep the images and the data folder in testdata/ or
private/, never in the repository.
"""
import argparse
import fcntl
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SOURCE = os.path.join(HERE, "install_firmware.cpp")
TOOL_DIR = os.path.join(HERE, "out", "tool")
WEB_TARGET = "bin/eka2l1_web.js"
WEB_OBJECT = "src/emu/web/CMakeFiles/eka2l1_web.dir/src/main.cpp.o"
# Settings for a Node program that reads and writes the host's files. The
# libraries were built with -pthread and wasm exceptions; those flags are taken
# from the web build's link line. A firmware image is read into memory whole, so
# the heap must be allowed to grow well past the browser build's 1 GB.
NODE_LINK = [
    "-O2", "-sNODERAWFS=1", "-sENVIRONMENT=node", "-sALLOW_MEMORY_GROWTH=1", "-sMAXIMUM_MEMORY=4GB",
    "-sINITIAL_MEMORY=268435456", "-sEXIT_RUNTIME=1", "-sSTACK_SIZE=4194304",
    "-sDEFAULT_PTHREAD_STACK_SIZE=2097152",
]
# Link options of the web build that belong to the browser page, not to the libraries.
BROWSER_ONLY_WITH_ARG = {"--preload-file", "--embed-file", "--shell-file", "--pre-js", "--post-js",
                         "--js-library", "--extern-pre-js", "--extern-post-js"}


def fail(message):
    print("install.py: " + message, file=sys.stderr)
    sys.exit(1)


def main_checkout():
    """The checkout that holds testdata/ and the web build: this one, or the main one of a worktree."""
    env = os.environ.get("ARCADE_MAIN")
    if env:
        return env
    git = os.path.join(ROOT, ".git")
    if os.path.isfile(git):  # a worktree: ".git" is a file pointing into <main>/.git/worktrees/<name>
        with open(git) as fh:
            target = fh.read().strip().removeprefix("gitdir:").strip()
        marker = os.sep + ".git" + os.sep
        if marker in target:
            return target.split(marker)[0]
    return ROOT


def default_build():
    for checkout in (ROOT, main_checkout()):
        folder = os.path.join(checkout, "eka2l1", "build", "web")
        if os.path.isfile(os.path.join(folder, "build.ninja")):
            return folder
    return os.path.join(main_checkout(), "eka2l1", "build", "web")


def ninja_unescape(value):
    out, i = [], 0
    while i < len(value):
        if value[i] == "$" and i + 1 < len(value) and value[i + 1] in "$ :":
            out.append(value[i + 1])
            i += 2
        else:
            out.append(value[i])
            i += 1
    return "".join(out)


def ninja_edges(path):
    """Map of each build edge's first output -> (rule, its variables)."""
    with open(path) as fh:
        text = fh.read().replace("$\n", "")
    edges, rules, current = {}, {}, None
    for line in text.split("\n"):
        if line.startswith("build "):
            head = line[len("build "):]
            outputs, _, rest = head.partition(": ")
            output = outputs.split(" ")[0]
            current = {}
            edges[ninja_unescape(output)] = (rest.split(" ")[0], current)
        elif line.startswith("rule "):
            current = {}
            rules[line[len("rule "):].strip()] = current
        elif line.startswith("  ") and current is not None and " = " in line:
            key, _, value = line.strip().partition(" = ")
            current[key] = ninja_unescape(value)
        elif line and not line.startswith(" "):
            current = None
    return edges, rules


def read_build(build):
    ninja = os.path.join(build, "build.ninja")
    if not os.path.isfile(ninja):
        fail(f"no build.ninja in {build}: build the player first (tools/ci/build-web.sh), or name the "
             "web build folder with --build")
    edges, rules = ninja_edges(ninja)
    rules_file = os.path.join(build, "CMakeFiles", "rules.ninja")
    if os.path.isfile(rules_file):
        rules.update(ninja_edges(rules_file)[1])
    if WEB_TARGET not in edges or WEB_OBJECT not in edges:
        fail(f"{ninja} has no eka2l1_web target: is {build} a web build of the fork?")
    compile_rule, compile_vars = edges[WEB_OBJECT]
    _, link_vars = edges[WEB_TARGET]
    libraries = shlex.split(link_vars.get("LINK_LIBRARIES", ""))
    missing = [lib for lib in libraries if lib.endswith(".a") and not os.path.isfile(os.path.join(build, lib))]
    if missing:
        fail(f"the web build in {build} is incomplete ({len(missing)} libraries missing, first {missing[0]}): "
             "build it first")
    link_flags, skip = [], False
    for flag in shlex.split(link_vars.get("LINK_FLAGS", "")):
        if skip:
            skip = False
        elif flag in BROWSER_ONLY_WITH_ARG:
            skip = True
        elif not flag.startswith("-s"):
            link_flags.append(flag)
    return {
        "ninja": ninja,
        "compiler": find_compiler(rules.get(compile_rule, {}).get("command", "")),
        "compile": shlex.split(compile_vars.get("DEFINES", "")) + shlex.split(compile_vars.get("INCLUDES", ""))
        + shlex.split(compile_vars.get("FLAGS", "")),
        "link": link_flags,
        "libraries": libraries,
    }


def find_compiler(command):
    """em++ as the build's rule names it, else the one on PATH."""
    for token in command.replace("}", "} ").split():
        if os.path.basename(token) == "em++" and os.path.isfile(token):
            return token
    found = shutil.which("em++")
    if not found:
        fail("em++ not found: the build's compiler is gone and none is on PATH (run `. tools/env.sh`)")
    return found


def file_state(path):
    stat = os.stat(path)
    return [path, stat.st_size, stat.st_mtime_ns]


def build_tool(build):
    """Compile and link the tool unless an up-to-date one exists; returns its .js path."""
    info = read_build(build)
    os.makedirs(TOOL_DIR, exist_ok=True)
    tool = os.path.join(TOOL_DIR, "install_firmware.js")
    obj = os.path.join(TOOL_DIR, "install_firmware.o")
    compile_cmd = [info["compiler"], *info["compile"], "-c", SOURCE, "-o", obj]
    link_cmd = [info["compiler"], obj, *info["link"], *NODE_LINK, *info["libraries"], "-o", tool]
    inputs = [file_state(SOURCE), file_state(info["ninja"])] + [
        file_state(os.path.join(build, lib)) for lib in dict.fromkeys(info["libraries"]) if lib.endswith(".a")]
    stamp = {"build": build, "compile": compile_cmd, "link": link_cmd, "inputs": inputs}
    stamp_path = os.path.join(TOOL_DIR, "stamp.json")
    try:
        with open(stamp_path) as fh:
            if json.load(fh) == stamp and os.path.isfile(tool) and os.path.isfile(tool[:-3] + ".wasm"):
                return tool
    except (OSError, ValueError):
        pass
    if os.path.exists(stamp_path):
        os.remove(stamp_path)
    print(f"building the firmware tool against {build} (about a minute)", flush=True)
    for step, cmd in (("compile", compile_cmd), ("link", link_cmd)):
        result = subprocess.run(cmd, cwd=build)
        if result.returncode != 0:
            fail(f"{step} of install_firmware.cpp failed (exit {result.returncode})")
    with open(stamp_path, "w") as fh:
        json.dump(stamp, fh, indent=1)
    return tool


def write_vpl(folder, images, description):
    """A VPL naming the images, with links to them beside it: the installer looks for them there."""
    vpl = os.path.join(folder, "firmware.vpl")
    names = [os.path.basename(image) for _, image in images]
    if len(set(names)) != len(names) or os.path.basename(vpl) in names:
        fail("two of the images have the same file name, or one is called firmware.vpl")
    files = []
    for subtype, image in images:
        name = os.path.basename(image)
        os.symlink(os.path.abspath(image), os.path.join(folder, name))
        files.append(f"      <File><Name>{escape(name)}</Name><FileType>Binary</FileType>"
                     f"<FileSubType>{subtype}</FileSubType></File>")
    with open(vpl, "w") as fh:
        fh.write('<?xml version="1.0" encoding="UTF-8" ?>\n<VariantPackingList>\n  <Variant>\n'
                 "    <VariantIdentification>\n"
                 f"      <Description>{escape(description)}</Description>\n"
                 "    </VariantIdentification>\n    <FileList>\n" + "\n".join(files) + "\n"
                 "    </FileList>\n  </Variant>\n</VariantPackingList>\n")
    return vpl


def main():
    global TOOL_DIR
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--vpl", help="a VPL file; the images it names must be beside it")
    parser.add_argument("--mcu", help="the Mcu image (the ROM and the core ROFS)")
    parser.add_argument("--ppm", help="the Ppm image (language variant)")
    parser.add_argument("--content", help="the Content image (user data for drive C)")
    parser.add_argument("--description", help="the variant's description in a written VPL (default: from --mcu)")
    parser.add_argument("--variant", type=int, default=0, help="variant of the VPL to install (default 0)")
    parser.add_argument("--out", required=True, help="the data folder to install into")
    parser.add_argument("--build", default=default_build(), help="the web build folder (default: %(default)s)")
    parser.add_argument("--tool-dir", default=TOOL_DIR, help="where the tool is built (default: %(default)s)")
    args = parser.parse_args()
    TOOL_DIR = os.path.abspath(args.tool_dir)

    if bool(args.vpl) == bool(args.mcu):
        parser.error("give either --vpl or --mcu (with --ppm and --content if there are such images)")
    if args.vpl and (args.ppm or args.content or args.description):
        parser.error("--ppm, --content and --description go with --mcu, not with --vpl")
    if args.variant < 0:
        parser.error("--variant must be 0 or more")
    if args.mcu and args.variant:
        parser.error("--variant goes with --vpl: a VPL written for --mcu has one variant")
    for path in (args.vpl, args.mcu, args.ppm, args.content):
        if path and not os.path.isfile(path):
            fail(f"no such file: {path}")

    node = shutil.which("node")
    if not node:
        fail("node not found on PATH (run `. tools/env.sh`)")
    build = os.path.abspath(args.build)
    if not os.path.isdir(build):
        fail(f"no web build folder at {build}: build the player first (tools/ci/build-web.sh) or pass --build")
    out = os.path.abspath(args.out)
    for sub in ("roms", os.path.join("drives", "z"), os.path.join("drives", "c")):
        os.makedirs(os.path.join(out, sub), exist_ok=True)

    os.makedirs(TOOL_DIR, exist_ok=True)
    # One run at a time builds or uses the tool, so no run meets a half-linked one.
    with open(os.path.join(TOOL_DIR, "lock"), "w") as lock, tempfile.TemporaryDirectory(prefix="ngage-vpl-") as scratch:
        fcntl.flock(lock, fcntl.LOCK_EX)
        tool = build_tool(build)
        if args.vpl:
            vpl = os.path.abspath(args.vpl)
        else:
            images = [(kind, path) for kind, path in
                      (("Mcu", args.mcu), ("Ppm", args.ppm), ("Content", args.content)) if path]
            vpl = write_vpl(scratch, images, args.description or "Firmware from " + os.path.basename(args.mcu))
        # The tool's log file (EKA2L1.log) goes to the current folder: keep it beside the tool.
        result = subprocess.run([node, tool, vpl, out, str(args.variant)], cwd=TOOL_DIR)
    if result.returncode != 0:
        fail(f"the firmware was not installed (see the message above, and {os.path.join(TOOL_DIR, 'EKA2L1.log')})")
    print(f"installed into {out}")
    print(f"pack it with: python3 -I tools/devices/pack.py --data {shlex.quote(out)}")


if __name__ == "__main__":
    main()
