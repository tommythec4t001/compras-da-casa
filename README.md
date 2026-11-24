# Compras da Casa

App de celular (site instalável) com as promoções do Super Muffato que interessam à casa e o resumo da compra pronta para pagar.

- `index.html`: o app. Abra no iPhone pelo Safari e use "Adicionar à Tela de Início".
- `data/`: lista acompanhada (`config.json`), histórico de preços, promoções e compra atual.
- `scripts/atualizar.mjs`: confere os preços pela busca pública do site. Não mexe em carrinho nem em conta.
- `.github/workflows/atualizar.yml`: roda o script todo dia às 9h17 (horário de Londrina).
