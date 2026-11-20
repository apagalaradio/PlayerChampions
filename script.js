// Normaliza el nombre ingresado al formato de título de página de MediaWiki
// (espacios -> guion bajo). La primera letra la capitaliza el propio wiki.
function normalizePlayerName(name) {
  return name.trim().replace(/\s+/g, "_");
}

// Busca, dentro de una página anual ya parseada, todas las tablas
// "por campeón" (encabezado: Champion | G | W | L | WR | ...) y suma
// las partidas (columna G) y victorias (columna W) de cada campeón a `counts`.
// `counts[champ]` = { games, wins }. Devuelve { games, wins } de esta página.
function extractChampionsFromDoc(doc, counts) {
  const tables = doc.querySelectorAll("table");
  let gamesFound = 0;
  let winsFound = 0;

  tables.forEach(table => {
    const rows = Array.from(table.rows);
    let winsCol = -1;
    const headerRowIndex = rows.findIndex(r => {
      const cells = Array.from(r.children).map(c => c.textContent.trim());
      const isHeader = /^champion$/i.test(cells[0] || "") && /^g$/i.test(cells[1] || "");
      if (isHeader) winsCol = cells.findIndex(c => /^w$/i.test(c));
      return isHeader;
    });
    if (headerRowIndex === -1) return; // no es una tabla "por campeón"

    for (let r = headerRowIndex + 1; r < rows.length; r++) {
      const cells = rows[r].children;
      if (!cells[0] || !cells[1]) continue;
      const champ = cells[0].textContent.trim();
      const games = parseInt(cells[1].textContent.trim(), 10);
      if (!champ || /^total:?$/i.test(champ) || isNaN(games)) continue;

      let wins = winsCol !== -1 && cells[winsCol]
        ? parseInt(cells[winsCol].textContent.trim(), 10)
        : NaN;
      if (isNaN(wins)) wins = 0;

      if (!counts[champ]) counts[champ] = { games: 0, wins: 0 };
      counts[champ].games += games;
      counts[champ].wins += wins;
      gamesFound += games;
      winsFound += wins;
    }
  });

  return { games: gamesFound, wins: winsFound };
}

function formatWinrate(wins, games) {
  return games > 0 ? ((wins / games) * 100).toFixed(1) + "%" : "-";
}

// ---- Ordenamiento de la tabla ----
// Filas actuales (una por campeón) y estado del orden vigente.
let currentRows = [];
let sortState = { key: "games", dir: "desc" };

// Compara dos filas según la columna indicada.
function compareRows(a, b, key) {
  if (key === "champ") return a.champ.localeCompare(b.champ, undefined, { sensitivity: "base" });
  return a[key] - b[key];
}

// Ordena `currentRows` y vuelve a dibujar el cuerpo de la tabla y las flechas.
function renderTable() {
  const tbody = document.getElementById("tbody");
  const factor = sortState.dir === "asc" ? 1 : -1;

  currentRows.sort((a, b) => {
    const diff = compareRows(a, b, sortState.key) * factor;
    // Desempate estable: por nombre de campeón.
    return diff !== 0 ? diff : a.champ.localeCompare(b.champ);
  });

  tbody.innerHTML = "";
  currentRows.forEach(row => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${row.champ}</td><td>${row.games}</td>` +
                   `<td>${row.wins}</td><td>${row.losses}</td>` +
                   `<td>${formatWinrate(row.wins, row.games)}</td>`;
    tbody.appendChild(tr);
  });

  document.querySelectorAll("#result th").forEach(th => {
    const arrow = th.querySelector(".arrow");
    if (!arrow) return;
    arrow.textContent = th.dataset.key === sortState.key
      ? (sortState.dir === "asc" ? "▲" : "▼")
      : "";
  });
}

// Al pulsar un encabezado: si ya era la columna activa, invierte el sentido;
// si es otra, la ordena (texto: A→Z, números: de mayor a menor).
document.querySelectorAll("#result th[data-key]").forEach(th => {
  th.addEventListener("click", () => {
    const key = th.dataset.key;
    if (sortState.key === key) {
      sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
    } else {
      sortState = { key, dir: key === "champ" ? "asc" : "desc" };
    }
    renderTable();
  });
});

// Descubre todas las páginas "Jugador/Statistics/AÑO" que existen realmente
// en el wiki para ese jugador, en vez de asumir un rango fijo de años.
async function findStatisticsYearPages(player) {
  const prefix = `${player}/Statistics/`;
  const url = `https://lol.fandom.com/api.php?action=query&format=json&list=allpages` +
              `&apprefix=${encodeURIComponent(prefix)}&apnamespace=0&aplimit=500&origin=*`;

  const res = await fetch(url);
  const data = await res.json();

  const pages = (data.query && data.query.allpages) || [];
  // La API devuelve los títulos con ESPACIOS (no guiones bajos), sin importar
  // cómo se haya escrito el prefijo en la consulta. Normalizamos antes de comparar.
  const yearPagePattern = new RegExp(
    "^" + prefix.replace(/_/g, " ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\d{4}$"
  );

  return pages
    .map(p => p.title)
    .filter(title => yearPagePattern.test(title))
    .sort();
}

async function searchPlayer(rawName) {
  const statusEl = document.getElementById('status');
  const totalGamesEl = document.getElementById('totalGames');
  const resultEl = document.getElementById('result');
  const noteEl = document.getElementById('note');
  const tbody = document.getElementById('tbody');
  const btn = document.getElementById('searchBtn');

  // Reset de la vista
  tbody.innerHTML = "";
  resultEl.style.display = "none";
  totalGamesEl.style.display = "none";
  noteEl.style.display = "none";

  const player = normalizePlayerName(rawName);
  if (!player) {
    statusEl.textContent = "Escribe el nombre de un jugador.";
    return;
  }

  btn.disabled = true;
  statusEl.textContent = `Buscando páginas de estadísticas de "${player}"...`;

  try {
    const yearPages = await findStatisticsYearPages(player);

    if (yearPages.length === 0) {
      statusEl.textContent = `No se encontraron páginas de estadísticas para "${player}". ` +
        `Revisa que el nombre coincida exactamente con el usado en Leaguepedia.`;
      btn.disabled = false;
      return;
    }

    const counts = {};
    let totalGames = 0;
    let totalWins = 0;

    for (let i = 0; i < yearPages.length; i++) {
      const pageTitle = yearPages[i];
      statusEl.textContent = `Cargando ${pageTitle}... (${i + 1}/${yearPages.length})`;

      const url = `https://lol.fandom.com/api.php?action=parse&page=${encodeURIComponent(pageTitle)}&format=json&prop=text&origin=*`;
      const res = await fetch(url);
      const data = await res.json();

      if (data.error) continue;

      const html = data.parse.text["*"];
      const doc = new DOMParser().parseFromString(html, "text/html");

      const page = extractChampionsFromDoc(doc, counts);
      totalGames += page.games;
      totalWins += page.wins;
    }

    currentRows = Object.entries(counts).map(([champ, stats]) => ({
      champ,
      games: stats.games,
      wins: stats.wins,
      losses: stats.games - stats.wins,
      wr: stats.games > 0 ? stats.wins / stats.games : 0
    }));

    if (currentRows.length === 0) {
      statusEl.textContent = `Se encontraron páginas para "${player}" pero no se pudo extraer ningún campeón.`;
      btn.disabled = false;
      return;
    }

    // Cada búsqueda nueva parte del orden por defecto: más jugados primero.
    sortState = { key: "games", dir: "desc" };
    renderTable();

    totalGamesEl.textContent = `Jugador: ${player.replace(/_/g, " ")} — Total de partidas contabilizadas: ${totalGames} ` +
      `(winrate global: ${formatWinrate(totalWins, totalGames)}, ${yearPages.length} año/s)`;
    totalGamesEl.style.display = "block";

    statusEl.textContent = "";
    resultEl.style.display = "table";
    noteEl.style.display = "block";

  } catch (err) {
    statusEl.textContent = "Error al cargar los datos: " + err.message;
    console.error(err);
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('searchBtn').addEventListener('click', () => {
  searchPlayer(document.getElementById('playerInput').value);
});

document.getElementById('playerInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    searchPlayer(document.getElementById('playerInput').value);
  }
});
