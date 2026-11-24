// Manda para a planilha de despesas (Google Sheets) cada compra marcada como paga.
// Precisa do segredo PLANILHA_URL no GitHub (endereço do script da planilha + ?token=...).
import { readFile, writeFile } from "node:fs/promises";

const url = process.env.PLANILHA_URL;
if (!url) { console.log("Planilha desligada (falta o segredo PLANILHA_URL)."); process.exit(0); }

let gastos = [];
try { gastos = JSON.parse(await readFile("data/gastos.json", "utf8")); } catch { process.exit(0); }

const dataSP = (iso) => new Date(Date.parse(iso) - 3 * 3600 * 1000).toISOString().slice(0, 10);
let enviados = 0;
for (const g of gastos) {
  if (g.planilha) continue;
  const lojas = (g.lojas && g.lojas.length ? g.lojas : ["Super Muffato"]).join(" + ");
  const corpo = {
    id: g.id, data: dataSP(g.pagaEm), descricao: g.teste ? "TESTE do app Compras da Casa - pode apagar" : `Mercado - ${lojas} (app Compras da Casa)`,
    categoria: "Supermercados", valor: g.valor, quemPagou: "Andréia", para: "Casa",
  };
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo), redirect: "follow" });
    const texto = await r.text();
    let resp = {};
    try { resp = JSON.parse(texto); } catch { throw new Error("resposta inesperada: " + texto.slice(0, 120)); }
    if (!resp.ok) throw new Error(resp.erro || "recusado");
    g.planilha = resp.aba || "ok";
    enviados++;
    console.log(`Lançado na planilha: ${corpo.descricao}, R$ ${g.valor} (${g.planilha}).`);
  } catch (e) {
    console.error(`Não consegui lançar ${g.id}: ${e.message}`);
  }
}
if (enviados) await writeFile("data/gastos.json", JSON.stringify(gastos, null, 2) + "\n");
