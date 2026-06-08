import matplotlib.pyplot as plt
import matplotlib.ticker as ticker
from pathlib import Path

OUT = Path(__file__).parent

h_n     = [10,20,50,75,100,125,150,175,200,250,350,500,650,800,1000,1500,2000,3000,5000,7500,9500]
h_c1    = [7.15,12.80,28.40,30.70,49.80,57.85,69.35,71.55,86.60,118.20,163.60,191.65,235.05,344.75,388.85,518.75,706.35,905.55,1053.50,1520.00,2022.50]
h_build = [134.02,277.12,648.19,824.41,1083.76,1338.62,1773.39,2104.17,2347.84,2922.88,4069.87,5878.97,7591.89,9402.56,11881.25,18020.75,24277.83,36931.92,62063.66,94112.28,119559.85]
h_p50   = [4.262,4.859,4.669,4.003,4.070,3.857,4.385,4.423,4.573,4.536,4.619,4.596,4.581,4.809,4.689,4.854,5.015,5.115,5.063,5.365,5.470]
h_p95   = [7.003,9.507,12.034,9.002,9.779,9.540,10.441,10.656,10.910,10.415,10.173,9.769,9.789,9.888,9.643,9.746,9.983,9.989,9.974,10.268,10.326]

h_r1 = [c/n*100 for c,n in zip(h_c1, h_n)]

g_n     = [10,20,50,75,100,125,150,175,200,250,350,500,650,800,1000,1500,2000,3000,5000,7500,9500]
g_acc   = [50.00,55.00,66.00,58.67,57.00,52.00,48.67,47.70,46.23,42.97,40.40,37.68,34.05,31.41,30.53,27.22,26.06,24.60,19.32,11.92,8.99]
g_build = [91.004,102.745,249.508,389.123,511.834,594.895,642.274,667.551,864.108,1016.791,1585.641,2362.546,3590.094,3936.925,5015.767,7710.381,10452.050,16386.236,28525.082,44499.094,135854.377]
g_p50   = [0.240,0.200,0.259,0.477,0.348,0.462,0.361,0.465,0.548,0.467,0.449,0.573,0.854,0.783,0.899,1.123,1.464,2.019,3.597,10.054,13.484]
g_p95   = [2.356,1.821,2.008,3.868,2.916,2.591,2.036,2.748,2.999,2.559,2.514,3.000,4.291,3.792,3.959,5.573,6.085,7.718,13.863,43.683,56.438]

plt.rcParams.update({
    'figure.facecolor': "#ffffff",
    'axes.facecolor':   "#ffffff",
    'axes.edgecolor':   "#000000",
    'axes.labelcolor':  "#000000",
    'axes.titlecolor':  "#000000",
    'xtick.color':      "#000000",
    'ytick.color':      "#000000",
    'text.color':       "#000000",
    'grid.color':       "#b0b0b0",
    'grid.linewidth':   0.6,
    'font.family':      'monospace',
    'legend.framealpha': 0.15,
    'legend.edgecolor': "#000000",
    'legend.fontsize':  9,
})

HNSW_SOLID  = '#00d4ff'
HNSW_DASH   = '#5ef28d'
NGRAM_SOLID = '#f4b942'
NGRAM_DASH  = '#ff6b6b'

KW_H = dict(linewidth=2.0, marker='o', markersize=3.5)
KW_G = dict(linewidth=2.0, marker='s', markersize=3.5, linestyle='--')

x_ticks = [10, 50, 100, 500, 1000, 5000, 9500]

def style_axes(ax):
    for spine in ax.spines.values():
        spine.set_color('black')

def save(fig, name):
    path = OUT / name
    fig.savefig(
        path,
        dpi=160,
        bbox_inches='tight',
        facecolor=fig.get_facecolor()
    )
    print(f"saved → {path}")
    plt.close(fig)

fig, ax = plt.subplots(figsize=(8, 6))
fig.patch.set_facecolor("#ffffff")

style_axes(ax)

ax.plot(h_n, h_r1,  color=HNSW_SOLID,  label='HNSW',  **KW_H)
ax.plot(g_n, g_acc, color=NGRAM_SOLID, label='NGram', **KW_G)

ax.set_xscale('log')

ax.set_title('Accuracy', fontsize=12, pad=12)
ax.set_xlabel('Document Count (log)', fontsize=10)
ax.set_ylabel('Accuracy (%)', fontsize=10)

ax.set_ylim(0, 110)

ax.yaxis.set_major_formatter(ticker.FormatStrFormatter('%.0f%%'))

ax.set_xticks(x_ticks)
ax.get_xaxis().set_major_formatter(ticker.ScalarFormatter())

ax.grid(True, which='both', linestyle='--')

ax.legend(loc='upper left')

fig.tight_layout()

save(fig, '1_accuracy_accuracy.png')

fig, ax = plt.subplots(figsize=(8, 6))
fig.patch.set_facecolor('#ffffff')

style_axes(ax)

ax.plot(
    h_n,
    [b / 1000 for b in h_build],
    color=HNSW_SOLID,
    label='HNSW',
    **KW_H
)

ax.plot(
    g_n,
    [b / 1000 for b in g_build],
    color=NGRAM_SOLID,
    label='NGram',
    **KW_G
)

ax.set_xscale('log')
ax.set_yscale('log')

ax.set_title('Build Time', fontsize=12, pad=12)

ax.set_xlabel('Document Count (log)', fontsize=10)
ax.set_ylabel('Time (s, log)', fontsize=10)

ax.set_xticks(x_ticks)
ax.get_xaxis().set_major_formatter(ticker.ScalarFormatter())

ax.yaxis.set_major_formatter(ticker.ScalarFormatter())

ax.grid(True, which='both', linestyle='--')

ax.legend()

fig.tight_layout()

save(fig, '2_build_time.png')

fig, ax = plt.subplots(figsize=(8, 6))
fig.patch.set_facecolor('#ffffff')

style_axes(ax)

ax.plot(h_n, h_p50, color=HNSW_SOLID,  label='HNSW p50', **KW_H)
ax.plot(h_n, h_p95, color=HNSW_DASH,   label='HNSW p95', **KW_H)

ax.plot(g_n, g_p50, color=NGRAM_SOLID, label='NGram p50', **KW_G)
ax.plot(g_n, g_p95, color=NGRAM_DASH,  label='NGram p95', **KW_G)

ax.set_xscale('log')

ax.set_title('Query Latency', fontsize=12, pad=12)

ax.set_xlabel('Document Count (log)', fontsize=10)
ax.set_ylabel('Latency (ms)', fontsize=10)

ax.set_xticks(x_ticks)
ax.get_xaxis().set_major_formatter(ticker.ScalarFormatter())

ax.grid(True, which='both', linestyle='--')

ax.legend()

fig.tight_layout()

save(fig, '3_query_latency.png')