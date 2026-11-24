// Envia avisos (notificações) para os celulares que ativaram:
// - compra pronta para pagar (uma vez por compra)
// - promoção nova da lista (só as que ainda não foram avisadas)
// Roda depois do atualizar.mjs. Precisa do segredo VAPID_PRIVATE no GitHub.
import { readFile, writeFile } from "node:fs/promises";
import webpush from "web-push";

const lerJson = async (p, padrao) => { try { return JSON.parse(await readFile(p, "utf8")); } catch { return padrao; } };
const reais = (n) => "R$ " + Number(n).toFixed(2).replace(".", ",");

const privada = process.env.VAPID_PRIVATE;
const config = await lerJson("data/config.json", {});
const publica = config.avisos?.chavePublica;
if (!privada || !publica || !config.supabase) { console.log("Avisos desligados (falta a chave ou o banco)."); process.exit(0); }
webpush.setVapidDetails("https://tommythec4t001.github.io/compras-da-casa/", publica, privada);

const SB = config.supabase;
const cab = { apikey: SB.chave, Authorization: `Bearer ${SB.chave}` };
let assinaturas = [];
try {
  const r = await fetch(`${SB.url}/rest/v1/assinaturas?select=endpoint,p256dh,auth`, { headers: cab });
  if (!r.ok) throw new Error("HTTP " + r.status);
  assinaturas = await r.json();
} catch (e) { console.error("Não consegui ler as assinaturas:", e.message); process.exit(0); }

const compra = await lerJson("data/compra.json", {});
const promos = (await lerJson("data/promocoes.json", { itens: [] })).itens || [];
const primeiraVez = !(await lerJson("data/avisos.json", null));
const estado = await lerJson("data/avisos.json", { compraAvisada: null, promosAvisadas: [] });

const mensagens = [];
if (process.env.TESTE === "1") mensagens.push({ titulo: "Avisos funcionando ✅", texto: "É assim que você vai saber da compra pronta e das promoções.", tag: "teste", url: "./#compra" });

// Compra pronta (não avisa a compra antiga montada à mão)
if (compra.status === "aguardando" && compra.id && !String(compra.id).startsWith("manual") && compra.id !== estado.compraAvisada) {
  if (!primeiraVez) mensagens.push({ titulo: "Compra pronta para pagar 🛒", texto: `${(compra.itens || []).length} produtos · ${reais(compra.total)}. Toque para colocar no carrinho.`, tag: "compra", url: "./#compra" });
  estado.compraAvisada = compra.id;
}

// Promoções novas
const nomes = promos.map((p) => p.nome);
const novas = promos.filter((p) => !estado.promosAvisadas.includes(p.nome));
if (novas.length && !primeiraVez) {
  const p = novas[0];
  const desc = p.desconto ? ` (-${p.desconto}%)` : "";
  mensagens.push({
    titulo: novas.length > 1 ? `${novas.length} promoções novas da sua lista 🔥` : "Promoção da sua lista 🔥",
    texto: `${p.nome}${p.loja && p.loja !== "Super Muffato" ? " no " + p.loja : ""}: ${reais(p.preco)}${desc}` + (novas.length > 1 ? ` e mais ${novas.length - 1}.` : "."),
    tag: "promo", url: "./#promos",
  });
}
estado.promosAvisadas = nomes;

let enviados = 0;
for (const m of mensagens) for (const a of assinaturas) {
  try {
    await webpush.sendNotification({ endpoint: a.endpoint, keys: { p256dh: a.p256dh, auth: a.auth } }, JSON.stringify(m), { TTL: 86400 });
    enviados++;
  } catch (e) {
    console.warn(`Falha ao avisar (${e.statusCode || e.message}).`);
    if (e.statusCode === 404 || e.statusCode === 410) {
      await fetch(`${SB.url}/rest/v1/assinaturas?endpoint=eq.${encodeURIComponent(a.endpoint)}`, { method: "DELETE", headers: cab }).catch(() => {});
    }
  }
}
await writeFile("data/avisos.json", JSON.stringify(estado, null, 2) + "\n");
console.log(`${mensagens.length} aviso(s), ${enviados} entrega(s), ${assinaturas.length} celular(es).`);
