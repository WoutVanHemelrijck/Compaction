import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.ticker as ticker
from pathlib import Path

OUT = Path(__file__).parent

df = pd.read_csv(OUT / "Mresults.csv")

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

HNSW_SOLID = '#00d4ff'
HNSW_DASH  = '#5ef28d'
HNSW_ALT   = '#f4b942'

KW = dict(linewidth=2.0, marker='o', markersize=4)

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

m_vals = df["M"]

fig, ax = plt.subplots(figsize=(8, 6))
fig.patch.set_facecolor("#ffffff")

style_axes(ax)

ax.plot(
    m_vals,
    df["correct1"] / df["insertCount"] * 100,
    color=HNSW_SOLID,
    label='Accuracy',
    **KW
)

ax.set_title('Accuracy', fontsize=12, pad=12)

ax.set_xlabel('M', fontsize=10)
ax.set_ylabel('Accuracy (%)', fontsize=10)

ax.yaxis.set_major_formatter(ticker.FormatStrFormatter('%.0f%%'))

ax.grid(True, linestyle='--')

ax.legend()

fig.tight_layout()

save(fig, 'm_accuracy.png')

fig, ax = plt.subplots(figsize=(8, 6))
fig.patch.set_facecolor("#ffffff")

style_axes(ax)

ax.plot(
    m_vals,
    df["buildTimeMs"] / 1000,
    color=HNSW_SOLID,
    label='Build Time',
    **KW
)

ax.set_title('Build Time', fontsize=12, pad=12)

ax.set_xlabel('M', fontsize=10)
ax.set_ylabel('Time (s)', fontsize=10)

ax.grid(True, linestyle='--')

ax.legend()

fig.tight_layout()

save(fig, 'm_build_time.png')

fig, ax = plt.subplots(figsize=(8, 6))
fig.patch.set_facecolor("#ffffff")

style_axes(ax)

ax.plot(
    m_vals,
    df["p50_ms"],
    color=HNSW_SOLID,
    label='p50',
    **KW
)

ax.plot(
    m_vals,
    df["p95_ms"],
    color=HNSW_DASH,
    label='p95',
    **KW
)

ax.plot(
    m_vals,
    df["p99_ms"],
    color=HNSW_ALT,
    label='p99',
    **KW
)

ax.set_title('Query Latency', fontsize=12, pad=12)

ax.set_xlabel('M', fontsize=10)
ax.set_ylabel('Latency (ms)', fontsize=10)

ax.grid(True, linestyle='--')

ax.legend()

fig.tight_layout()

save(fig, 'm_query_latency.png')