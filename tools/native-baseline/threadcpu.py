import sys, time, os, json, urllib.request
pid, secs = sys.argv[1], float(sys.argv[2])
def snap():
    out = {}
    for t in os.listdir(f'/proc/{pid}/task'):
        try:
            s = open(f'/proc/{pid}/task/{t}/stat').read()
            name = s[s.index('(')+1:s.rindex(')')]
            f = s[s.rindex(')')+2:].split()
            out[t] = (name, int(f[11]) + int(f[12]))
        except OSError: pass
    return out
def frames():
    return json.load(urllib.request.urlopen('http://127.0.0.1:8765/v1/status', timeout=5))['frames']
a, fa = snap(), frames(); time.sleep(secs); b, fb = snap(), frames()
hz = os.sysconf('SC_CLK_TCK')
print(f'fps: {(fb-fa)/secs:.1f}')
rows = sorted(((b[t][1]-a[t][1], b[t][0]) for t in b if t in a), reverse=True)
for d, n in rows[:6]:
    print(f'  {n:20s} {100*d/hz/secs:5.1f}% of one core')
print(f'  TOTAL {100*sum(d for d,_ in rows)/hz/secs:.1f}%')
