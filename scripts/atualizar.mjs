// Compras da Casa: roda pelo GitHub Actions.
// 1) Uma vez por dia: confere preços e promoções da lista e guarda o histórico.
// 2) A cada rodada: lê no Supabase o que acabou em casa e monta a compra
//    (mais barato de cada item, seguindo as regras da lista-base).
// Só lê a busca pública do Muffato. Não mexe em carrinho, conta nem pagamento.
import { readFile, writeFile } from "node:fs/promises";

const BASE = "https://www.supermuffato.com.br";
const DIAS_HISTORICO = 90;
const MIN_DIAS_MEDIA = 7;
const QUEDA_MINIMA = 0.15;
const MAX_PROMOS_POR_ITEM = 3;
const FAIXA_MIN = 0.75; // aceita de 75%…
const FAIXA_MAX = 1.35; // …até 135% da quantidade pedida
const TOLERANCIA_PREFERIDA = 1.1; // marca preferida se custar até 10% a mais

const lerJson = async (p, padrao) => { try { return JSON.parse(await readFile(p, "utf8")); } catch { return padrao; } };
const salvarJson = (p, d) => writeFile(p, JSON.stringify(d, null, 2) + "\n");
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const reais = (n) => "R$ " + n.toFixed(2).replace(".", ",");
const arred = (n) => Math.round(n * 100) / 100;

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

// ---------- Mercado Lisboa (loja virtual OpenCart; dados vêm no HTML da busca) ----------
const LISBOA = "https://www.lisboasupermercado.com.br";
async function buscarLisboa(termo) {
  const url = `${LISBOA}/index.php?route=product/search&search=${encodeURIComponent(termo)}&limit=100`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15", Accept: "text/html" } });
    if (!r.ok) { console.warn(`Lisboa HTTP ${r.status} (${termo})`); return null; }
    const html = await r.text();
    const out = [];
    for (const m of html.matchAll(/const args = \{([\s\S]*?)\};/g)) {
      const pega = (k) => (m[1].match(new RegExp(`'${k}':\\s*['"]([^'"]*)`)) || [])[1] || "";
      const num = (t) => parseFloat(String(t).replace(/[^\d.,]/g, "").replace(",", "."));
      const preco = num(pega("special")) || num(pega("price")), precoDe = num(pega("price"));
      out.push({ id: pega("product_id"), nome: pega("name").trim(), preco, precoDe, estoque: num(pega("stock")) || 0, imagem: pega("thumb"), link: pega("href") });
    }
    return out;
  } catch (e) { console.warn(`Lisboa falhou (${termo}): ${e.message}`); return null; }
}

// Promoções por quantidade (ex.: "60% Off 2un" = leve 2, 1 sai com 60% de desconto)
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

function oferta(produto) {
  const item = produto.items?.[0];
  const vendedor = item?.sellers?.find((s) => s.sellerDefault) || item?.sellers?.[0];
  const o = vendedor?.commertialOffer || {};
  return {
    sku: item?.itemId, nome: produto.productName?.trim(), preco: o.Price, precoDe: o.ListPrice,
    disponivel: o.AvailableQuantity > 0 && o.Price > 0, imagem: item?.images?.[0]?.imageUrl || "", leve: lerLeve(o),
  };
}

// Texto sem acento, minúsculo, com "5 kg" virando "5kg" e "5 Litros" virando "5l"
const normalizar = (t) => " " + String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/(\d)\s*(litros?|lts?)\b/g, "$1l").replace(/(\d)\s+(kg|g|ml|l|m|un|rolos)\b/g, "$1$2").replace(/\s+/g, " ").trim() + " ";

const temPalavra = (nome, w) => normalizar(nome).includes(normalizar(w).trim());

function combina(nome, item) {
  if ((item.precisaTer || []).some((w) => !temPalavra(nome, w))) return false;
  if ((item.naoPodeTer || []).some((w) => temPalavra(nome, w))) return false;
  if ((item.marcas || []).length && !item.marcas.some((w) => temPalavra(nome, w))) return false;
  return true;
}

// Quanto o produto tem, na medida do item (kg, l, rolos ou un)
function conteudo(nome, unidade) {
  const n = normalizar(nome);
  const num = (s) => parseFloat(String(s).replace(",", "."));
  let m;
  if (unidade === "kg") {
    if ((m = n.match(/(\d+(?:[.,]\d+)?)kg\b/))) return num(m[1]);
    if ((m = n.match(/(\d+)g\b/))) return num(m[1]) / 1000;
    return 0;
  }
  if (unidade === "l") {
    if ((m = n.match(/(\d+(?:[.,]\d+)?)l\b/))) return num(m[1]);
    if ((m = n.match(/(\d+)ml\b/))) return num(m[1]) / 1000;
    return 0;
  }
  if (unidade === "rolos") {
    let qtd = 0, metros = 0;
    if ((m = n.match(/(\d+)x(\d+)m\b/))) { qtd = +m[1]; metros = +m[2]; }
    else {
      m = n.match(/(\d+)\s*rolos\b/) || n.match(/leve (\d+)\b/) || n.match(/com (\d+)\b/) || n.match(/(\d+)\s*(?:un|unidades)\b/);
      if (m) qtd = +m[1];
      const mm = n.match(/(\d+)m\b/);
      if (mm) metros = +mm[1];
    }
    return qtd ? qtd * (metros ? metros / 30 : 1) : 0; // rolos equivalentes a 30 m
  }
  m = n.match(/leve (\d+)\b/) || n.match(/(\d+)\s*(?:un|unidades)\b/);
  return m ? +m[1] : 1;
}

// Custo de q unidades, já com promoção "leve N"
function custo(c, q) {
  let total = q * c.preco;
  if (c.leve?.pct && c.leve.n > 1) total -= Math.floor(q / c.leve.n) * c.preco * (c.leve.pct / 100);
  return total;
}

// Escolhe a combinação mais barata (até 2 produtos) que chegue perto da quantidade pedida
function escolher(item, candidatos) {
  const alvo = Number(item.alvo) || 1;
  const pontuar = (partes) => {
    const total = partes.reduce((s, p) => s + p.q * p.c.cont, 0);
    if (total < alvo * FAIXA_MIN || total > alvo * FAIXA_MAX) return null;
    const valor = partes.reduce((s, p) => s + custo(p.c, p.q), 0);
    return { partes, total, valor, nota: (valor / total) * (1 + 0.5 * Math.abs(total / alvo - 1)) };
  };
  const maxQ = (c) => Math.max(1, Math.floor((alvo * FAIXA_MAX) / c.cont));
  const cs = candidatos.slice().sort((a, b) => a.preco / a.cont - b.preco / b.cont).slice(0, 12);
  const opcoes = [];
  for (const c of cs) for (let q = 1; q <= maxQ(c); q++) { const o = pontuar([{ c, q }]); if (o) opcoes.push(o); }
  for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++)
    for (let qa = 1; qa <= maxQ(cs[i]); qa++) for (let qb = 1; qb <= maxQ(cs[j]); qb++) {
      const o = pontuar([{ c: cs[i], q: qa }, { c: cs[j], q: qb }]); if (o) opcoes.push(o);
    }
  if (!opcoes.length) {
    if (!cs.length) return null;
    const c = cs[0], q = Math.max(1, Math.round(alvo / c.cont));
    return { partes: [{ c, q }], total: q * c.cont, valor: custo(c, q), foraDaFaixa: true };
  }
  opcoes.sort((a, b) => a.nota - b.nota);
  const melhor = opcoes[0];
  if ((item.preferidas || []).length) {
    const ehPref = (o) => o.partes.every((p) => item.preferidas.some((w) => temPalavra(p.c.nome, w)));
    const pref = opcoes.find(ehPref);
    if (pref && pref.valor / pref.total <= (melhor.valor / melhor.total) * TOLERANCIA_PREFERIDA) return pref;
  }
  return melhor;
}

// ---------------------------------------------------------------------------
const config = await lerJson("data/config.json", { itens: [] });
const historico = await lerJson("data/historico.json", {});
const compraAtual = await lerJson("data/compra.json", {});
const promosAtuais = await lerJson("data/promocoes.json", { itens: [] });
const { data: hoje, iso } = agoraSP();
const sc = config.salesChannel;
const forcar = process.env.FORCAR === "1";

const doMuffato = (item) => !item.loja || item.loja === "Super Muffato";

// ---------- 1) Promoções e histórico (uma vez por dia ou quando forçado) ----------
if (forcar || !historico[hoje]) {
  const precosHoje = {}, imagens = {}, promos = [];
  let falhas = 0;
  for (const item of config.itens.filter(doMuffato)) {
    for (const sku of item.skus || []) {
      const res = await buscar(`fq=skuId:${sku}`, sc);
      if (!res) { falhas++; continue; }
      const p = res[0] ? oferta(res[0]) : null;
      if (p?.disponivel) { precosHoje[sku] = p.preco; imagens[sku] = p.imagem; }
    }
    const lista = await buscar(`ft=${encodeURIComponent(item.busca || item.nome)}&_from=0&_to=29`, sc);
    if (!lista) { falhas++; continue; }
    // Guarda o preço de todo produto que serve para o item (para o gráfico de preços)
    for (const o of lista.map(oferta)) if (o.disponivel && o.nome && combina(o.nome, item)) precosHoje[o.sku] = o.preco;
    const achados = lista.map(oferta)
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
      const media = o.leve && o.leve.pct ? arred(o.preco * (1 - o.leve.pct / 100 / o.leve.n)) : null;
      promos.push({
        nome: o.nome, item: item.nome, sku: o.sku,
        preco: o.porLeve && media ? media : o.preco,
        precoDe: o.porLeve && media ? o.preco : o.precoDe > o.preco ? o.precoDe : null,
        desconto: o.desconto || null, motivo: "lista", imagem: o.imagem,
        condicao: o.leve ? o.leve.texto + (o.porLeve && media ? ` (média de ${reais(media)} cada)` : "") : "",
        dica: item.estocavel ? "Não estraga: vale levar até 3." : "",
      });
    }
  }
  // Promoções e preços do Mercado Lisboa (se o site deixar)
  let lisboaOk = 0;
  for (const item of config.itens) {
    const termo = String(item.nome).replace(/\(.*?\)/g, "").trim();
    const lista = await buscarLisboa(termo);
    if (!lista) continue;
    lisboaOk++;
    const validos = lista.filter((o) => o.nome && o.preco > 0 && o.estoque > 0 && combina(o.nome, item));
    for (const o of validos) precosHoje["lisboa:" + o.id] = o.preco;
    validos.filter((o) => o.precoDe > o.preco)
      .map((o) => ({ ...o, desconto: Math.round((1 - o.preco / o.precoDe) * 100) }))
      .filter((o) => o.desconto >= 1)
      .sort((a, b) => b.desconto - a.desconto).slice(0, MAX_PROMOS_POR_ITEM)
      .forEach((o) => promos.push({
        nome: o.nome, item: item.nome, sku: "lisboa:" + o.id, loja: "Mercado Lisboa", link: o.link,
        preco: o.preco, precoDe: o.precoDe, desconto: o.desconto, motivo: "lista", imagem: o.imagem, condicao: "",
        dica: item.estocavel ? "Não estraga: vale levar até 3." : "",
      }));
  }
  console.log(`Mercado Lisboa: ${lisboaOk} de ${config.itens.length} buscas funcionaram.`);

  const diasAnteriores = Object.keys(historico).filter((d) => d < hoje).sort();
  for (const item of config.itens) for (const sku of item.skus || []) {
    const hojeP = precosHoje[sku];
    if (hojeP == null) continue;
    const anteriores = diasAnteriores.map((d) => historico[d][sku]).filter((v) => typeof v === "number");
    if (anteriores.length < MIN_DIAS_MEDIA) continue;
    const media = anteriores.reduce((a, b) => a + b, 0) / anteriores.length;
    if (hojeP <= media * (1 - QUEDA_MINIMA) && !promos.some((p) => p.item === item.nome && p.preco === hojeP)) {
      promos.push({ nome: item.nome, item: item.nome, preco: hojeP, precoDe: arred(media), desconto: Math.round((1 - hojeP / media) * 100), motivo: "abaixo_normal", sku, imagem: imagens[sku] || "", dica: (item.estocavel ? "Não estraga: vale levar até 3. " : "") + "Preço comparado com a média dos últimos dias." });
    }
  }
  if (falhas > config.itens.length) {
    console.error(`Muitas falhas no site do Muffato (${falhas}). Promoções não alteradas.`);
  } else {
    historico[hoje] = precosHoje;
    for (const d of Object.keys(historico).sort().slice(0, -DIAS_HISTORICO)) delete historico[d];
    await salvarJson("data/historico.json", historico);
    promos.sort((a, b) => (b.desconto || 0) - (a.desconto || 0));
    if (!igual(promos, promosAtuais.itens)) await salvarJson("data/promocoes.json", { atualizadoEm: iso, itens: promos });
    console.log(`Promoções: ${promos.length}.`);
  }
}

// ---------- 2) Compra: o que acabou em casa ----------
const SB = config.supabase || {};
async function sb(caminho) {
  const r = await fetch(`${SB.url}/rest/v1/${caminho}`, { headers: { apikey: SB.chave, Authorization: `Bearer ${SB.chave}` } });
  if (!r.ok) throw new Error(`Supabase HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

let faltando, pedidos;
try {
  faltando = await sb("faltando?select=id,item,observacao,criado_em&comprado_em=is.null&order=id");
  pedidos = await sb("pedidos?select=tipo,compra_id,criado_em,valor&order=criado_em.desc&limit=200")
    .catch(() => sb("pedidos?select=tipo,compra_id,criado_em&order=criado_em.desc&limit=200"));
} catch (e) {
  console.error(`Não consegui ler o Supabase: ${e.message}. Compra não alterada.`);
  process.exit(0);
}

const pagas = new Set(pedidos.filter((p) => p.tipo === "paguei").map((p) => p.compra_id));
const ultimaPaga = pedidos.find((p) => p.tipo === "paguei")?.criado_em || "";
const pediuAgora = pedidos.some((p) => p.tipo === "comprar_agora" && p.criado_em > ultimaPaga);

// Registra nos gastos a compra que acabou de ser paga
const gastos = await lerJson("data/gastos.json", []);
const pagamento = compraAtual.id && pedidos.find((p) => p.tipo === "paguei" && p.compra_id === compraAtual.id);
if (pagamento && !gastos.some((g) => g.id === compraAtual.id)) {
  const informado = Number(pagamento.valor);
  gastos.push({
    id: compraAtual.id, pagaEm: pagamento.criado_em,
    valor: informado > 0 ? arred(informado) : compraAtual.total, estimado: compraAtual.total,
    economia: compraAtual.economia || 0, produtos: (compraAtual.itens || []).length,
  });
  gastos.sort((a, b) => (a.pagaEm < b.pagaEm ? -1 : 1));
  await salvarJson("data/gastos.json", gastos);
  console.log(`Gasto registrado: ${reais(gastos[gastos.length - 1].valor)}.`);
}

if (!faltando.length) {
  // Nada marcado: mantém uma compra montada à mão que ainda não foi paga; senão, fica vazia
  const manualPendente = compraAtual.status === "aguardando" && !(compraAtual.faltandoIds || []).length && !pagas.has(compraAtual.id);
  if (!manualPendente) {
    const vazia = { status: "vazia", atualizadaEm: compraAtual.status === "vazia" ? compraAtual.atualizadaEm : iso };
    if (!igual(vazia, compraAtual)) await salvarJson("data/compra.json", vazia);
  }
  console.log("Compra: nada marcado como acabou.");
  process.exit(0);
}

const ids = faltando.map((f) => f.id);
const idCompra = "c" + ids.join("-") + (pediuAgora ? "-agora" : "");
const minimo = Number(config.minimoCompra) || 150;
if (compraAtual.id === idCompra && (compraAtual.criadaEm || "").slice(0, 10) === hoje && !forcar) {
  console.log("Compra: nada mudou desde a última rodada.");
  process.exit(0);
}

const porNome = new Map(config.itens.map((i) => [normalizar(i.nome).trim(), i]));
const itensCompra = [], trocas = [], fora = [], faltandoIds = [], outras = {};
const vistos = new Set();
let economia = 0;

for (const f of faltando) {
  const chave = normalizar(f.item).trim();
  faltandoIds.push(f.id);
  if (vistos.has(chave)) continue;
  vistos.add(chave);
  const item = porNome.get(chave);
  if (!item) { fora.push(`${f.item}: não está na lista-base. Coloque no carrinho à parte.`); continue; }
  if (!doMuffato(item)) {
    const marca = (item.marcas || [])[0] ? " " + item.marcas[0].replace(/\b\w/g, (l) => l.toUpperCase()) : "";
    const medida = { kg: "kg", l: "L", rolos: "rolos", un: "unidades" }[item.unidade || "un"];
    (outras[item.loja] ||= []).push({ item: item.nome + marca, quantidade: item.alvo ? `${String(item.alvo).replace(".", ",")} ${medida}` : "" });
    continue;
  }
  const lista = await buscar(`ft=${encodeURIComponent(item.busca || item.nome)}&_from=0&_to=49`, sc);
  const unidade = item.unidade || "un";
  const candidatos = (lista || []).map(oferta)
    .filter((o) => o.disponivel && o.nome && combina(o.nome, item))
    .map((o) => ({ ...o, cont: conteudo(o.nome, unidade) }))
    .filter((o) => o.cont > 0);
  const escolha = escolher(item, candidatos);
  if (!escolha) { fora.push(`${item.nome}: não encontrei no Muffato com as regras da lista.`); continue; }
  for (const { c, q } of escolha.partes) {
    const sub = arred(custo(c, q));
    const promo = c.precoDe > c.preco || !!(c.leve && q >= c.leve.n);
    economia += Math.max(0, (c.precoDe > c.preco ? (c.precoDe - c.preco) * q : 0) + (q * c.preco - custo(c, q)));
    itensCompra.push({ item: item.nome, nome: c.nome, sku: c.sku, qtd: q, preco: c.preco, subtotal: sub, promo, imagem: c.imagem });
  }
  const un = { kg: "kg", l: "L", rolos: "rolos", un: "un" }[unidade];
  const fmt = (v) => (Math.round(v * 100) / 100).toString().replace(".", ",");
  if (escolha.partes.length > 1) trocas.push(`${item.nome}: juntei ${escolha.partes.map((p) => p.q + "× " + p.c.nome).join(" + ")} para chegar perto de ${fmt(item.alvo)} ${un}.`);
  else if (escolha.foraDaFaixa || Math.abs(escolha.total / item.alvo - 1) > 0.1) trocas.push(`${item.nome}: o mais próximo de ${fmt(item.alvo)} ${un} foi ${fmt(escolha.total)} ${un}.`);
  if ((item.preferidas || []).length && !escolha.partes.every((p) => item.preferidas.some((w) => temPalavra(p.c.nome, w))))
    trocas.push(`${item.nome}: a marca preferida estava mais cara; veio ${escolha.partes[0].c.nome}.`);
}

const total = arred(itensCompra.reduce((s, i) => s + i.subtotal, 0));
const link = itensCompra.length
  ? `${BASE}/checkout/cart/add?` + itensCompra.map((i) => `sku=${i.sku}&qty=${i.qtd}&seller=1&sc=${sc}`).join("&")
  : "";

const compra = {
  id: idCompra,
  status: total >= minimo || pediuAgora ? "aguardando" : "acumulando",
  criadaEm: iso, minimo, total, frete: null, economia: arred(economia), pediuAgora,
  faltandoIds, itens: itensCompra, trocas, foraDaCompra: fora, linkCarrinho: link,
  outrasLojas: Object.entries(outras).map(([loja, itens]) => ({ loja, whatsapp: (config.outrasLojas || []).find((l) => l.nome === loja)?.whatsapp || "", itens })),
};
if (!itensCompra.length && compra.outrasLojas.length) compra.status = "aguardando";
await salvarJson("data/compra.json", compra);
console.log(`Compra ${compra.status}: ${itensCompra.length} produtos, ${reais(total)}.`);
