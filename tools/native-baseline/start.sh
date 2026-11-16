#!/bin/bash
# Start the official native EKA2L1 build with its HTTP control API on 127.0.0.1:8765.
# Data and settings stay inside .toolchain/native (nothing is written to $HOME).
N=/home/user/Documents/ShadowkeyWebPort/.toolchain/native
export LD_LIBRARY_PATH=$N/extralibs/usr/lib/x86_64-linux-gnu
XDG_CONFIG_HOME=$N/config XDG_DATA_HOME=$N/data exec $N/squashfs-root/AppRun --debug-control-port 8765 > $N/run.log 2>&1
