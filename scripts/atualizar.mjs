// Confere os preços da lista no Super Muffato, guarda o histórico do dia
// e atualiza data/promocoes.json. Roda todo dia pelo GitHub Actions.
// Não mexe em carrinho nem em conta: só lê a busca pública do site.
import { readFile, writeFile } from "node:fs/promises";

const BASE = "https://www.supermuffato.com.br";
const DIAS_HISTORICO = 90;
const MIN_DIAS_MEDIA = 7;
const QUEDA_MINIMA = 0.15; // 15% abaixo da média
const MAX_PROMOS_POR_ITEM = 3;

const lerJson = async (p) => JSON.parse(await readFile(p, "utf8"));
const salvarJson = (p, d) => writeFile(p, JSON.stringify(d, null, 2) + "\n");

function agoraSP() {
  const d = new Date(Date.now() - 3 * 3600 * 1000);
  return { data: d.toISOString().slice(0, 10), iso: d.toISOString().slice(0, 19) + "-03:00" };
}

async function buscar(params, sc) {
  const url = `${BASE}/api/catalog_system/pub/products/search?${params}&sc=${sc}`;
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compras-da-casa)", Accept: "application/json" } });
      if (r.ok) return await r.json();
      console.warn(`HTTP ${r.status} em ${url}`);
    } catch (e) {
      console.warn(`Falha em ${url}: ${e.message}`);
    }
    await new Promise((res) => setTimeout(res, 1500 * tentativa));
  }
  return null;
}

function oferta(produto) {
  const item = produto.items?.[0];
  const vendedor = item?.sellers?.find((s) => s.sellerDefault) || item?.sellers?.[0];
  const o = vendedor?.commertialOffer || {};
  return { sku: item?.itemId, nome: produto.productName?.trim(), preco: o.Price, precoDe: o.ListPrice, disponivel: o.AvailableQuantity > 0 && o.Price > 0, imagem: item?.images?.[0]?.imageUrl || "", leve: lerLeve(o) };
}

// Promoções por quantidade (ex.: "60% Off 2un" = leve 2, 1 sai com 60% de desconto).
// Elas não aparecem no preço "de/por"; só como "teaser" do produto.
function lerLeve(o) {
  const t = (o.PromotionTeasers || [])[0];
  if (!t) return null;
  const nome = String(t.Name || "");
  const minimo = t.Conditions?.MinimumQuantity || 0;
  const m = nome.match(/(\d+)\s*%\s*off\s*(\d+)\s*un/i);
  if (m) {
    const pct = +m[1], n = +m[2];
    return { pct, n, media: Math.round((pct / n) * 10) / 10, texto: `Leve ${n}: 1 sai com ${pct}% de desconto` };
  }
  return minimo > 1 ? { pct: 0, n: minimo, media: 0, texto: `Promoção na compra de ${minimo} ou mais` } : null;
}

// Texto sem acento, minúsculo, com "5 kg" virando "5kg"
const normalizar = (t) => " " + String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/(\d)\s*(litros?|lts?)\b/g, "$1l").replace(/(\d)\s+(kg|g|ml|l|m|un)\b/g, "$1$2").replace(/\s+/g, " ").trim() + " ";

// Regras da lista: tudo de "precisaTer", nada de "naoPodeTer" e, se houver, uma das "marcas"
function combina(nome, item) {
  const n = normalizar(nome);
  const tem = (w) => n.includes(normalizar(w).trim());
  if ((item.precisaTer || []).some((w) => !tem(w))) return false;
  if ((item.naoPodeTer || []).some((w) => tem(w))) return false;
  if ((item.marcas || []).length && !item.marcas.some((w) => tem(w))) return false;
  return true;
}

const config = await lerJson("data/config.json");
const historico = await lerJson("data/historico.json");
const { data: hoje, iso } = agoraSP();
const sc = config.salesChannel;

const precosHoje = {};
const imagens = {};
const promos = [];
let falhas = 0;

for (const item of config.itens) {
  // Preço dos produtos acompanhados
  for (const sku of item.skus || []) {
    const res = await buscar(`fq=skuId:${sku}`, sc);
    if (!res) { falhas++; continue; }
    const p = res[0] ? oferta(res[0]) : null;
    if (p?.disponivel) { precosHoje[sku] = p.preco; imagens[sku] = p.imagem; }
    else console.warn(`${item.nome}: produto ${sku} indisponível ou fora do site`);
  }

  // Alternativas permitidas pela regra da mãe que estejam em promoção
  const lista = await buscar(`ft=${encodeURIComponent(item.busca || item.nome)}&_from=0&_to=29`, sc);
  if (!lista) { falhas++; continue; }
  const achados = lista
    .map(oferta)
    .filter((o) => o.disponivel && o.nome && combina(o.nome, item) && (o.precoDe > o.preco || o.leve))
    .map((o) => {
      const direto = o.precoDe > o.preco ? (1 - o.preco / o.precoDe) * 100 : 0;
      const porLeve = o.leve?.media || 0;
      return { ...o, desconto: Math.round(Math.max(direto, porLeve)), porLeve: porLeve > direto };
    })
    .filter((o) => o.desconto >= 1 || o.leve)
    .sort((a, b) => b.desconto - a.desconto)
    .slice(0, MAX_PROMOS_POR_ITEM);
  for (const o of achados) {
    const media = o.leve && o.leve.pct ? Math.round(o.preco * (1 - o.leve.pct / 100 / o.leve.n) * 100) / 100 : null;
    promos.push({
      nome: o.nome, item: item.nome,
      preco: o.porLeve && media ? media : o.preco,
      precoDe: o.porLeve && media ? o.preco : o.precoDe > o.preco ? o.precoDe : null,
      desconto: o.desconto || null, motivo: "lista", imagem: o.imagem,
      condicao: o.leve ? o.leve.texto + (o.porLeve && media ? ` (média de R$ ${media.toFixed(2).replace(".", ",")} cada)` : "") : "",
      dica: item.estocavel ? "Não estraga: vale levar até 3." : ""
    });
  }
}

// Preço bem abaixo do normal (precisa de pelo menos 7 dias de histórico)
const diasAnteriores = Object.keys(historico).filter((d) => d < hoje).sort();
for (const item of config.itens) {
  for (const sku of item.skus || []) {
    const hojeP = precosHoje[sku];
    if (hojeP == null) continue;
    const anteriores = diasAnteriores.map((d) => historico[d][sku]).filter((v) => typeof v === "number");
    if (anteriores.length < MIN_DIAS_MEDIA) continue;
    const media = anteriores.reduce((a, b) => a + b, 0) / anteriores.length;
    if (hojeP <= media * (1 - QUEDA_MINIMA) && !promos.some((p) => p.item === item.nome && p.preco === hojeP)) {
      promos.push({ nome: item.nome, item: item.nome, preco: hojeP, precoDe: Math.round(media * 100) / 100, desconto: Math.round((1 - hojeP / media) * 100), motivo: "abaixo_normal", imagem: imagens[sku] || "", dica: (item.estocavel ? "Não estraga: vale levar até 3. " : "") + "Preço comparado com a média dos últimos dias." });
    }
  }
}

// Se o site não respondeu, não apaga o que já estava no app
if (falhas > config.itens.length) {
  console.error(`Muitas falhas (${falhas}). Nada foi alterado.`);
  process.exit(1);
}

historico[hoje] = precosHoje;
for (const d of Object.keys(historico).sort().slice(0, -DIAS_HISTORICO)) delete historico[d];
await salvarJson("data/historico.json", historico);

promos.sort((a, b) => (b.desconto || 0) - (a.desconto || 0));
await salvarJson("data/promocoes.json", { atualizadoEm: iso, itens: promos });

console.log(`${Object.keys(precosHoje).length} preços salvos, ${promos.length} promoções.`);
for (const p of promos) console.log(`- ${p.nome}: R$ ${p.preco} (-${p.desconto}%)`);
