# Compras da Casa

App de celular (site instalável) para as compras da casa no Super Muffato.

- **Acabou**: a família marca o que acabou (fica salvo no Supabase).
- **Compra**: a cada 30 minutos o GitHub Actions monta a compra com o mais barato de cada item, seguindo as regras da lista-base. Fica "pronta para pagar" quando passa do mínimo (R$ 150) ou com "Quero comprar agora". O botão leva tudo para o carrinho do Muffato; o pagamento é sempre feito pela pessoa.
- **Promoções**: uma vez por dia, itens da lista em promoção ou bem abaixo do preço normal.
- **Editar lista-base**: link no fim do app (precisa de um token do GitHub no aparelho).

Arquivos: `index.html` (app), `data/` (lista-base, histórico, promoções, compra), `scripts/atualizar.mjs` (busca pública do Muffato + leitura do Supabase), `.github/workflows/atualizar.yml` (agenda).
