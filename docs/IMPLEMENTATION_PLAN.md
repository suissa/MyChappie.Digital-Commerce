# HyperCommerce — Plano de Implementação

> Complementa `../README.md` (contrato do módulo). Sequenciado por dependência real.
>
> **Convenções Lucy-mae** (`CLAUDE.md`): `src/entities/<name>/`; schema **dual** (`migration.ts` + `schema.prisma`); `*_cents`; Zod em `shared/validation`; caminho vivo = `container.ts` + Express + `EventEmitter2`. Nome interno: `products` (já existe: CRUD `products` com `sku`, `salePriceCents`, `averageCostCents`). HyperCommerce é a evolução de `products` para catálogo mestre + pricing + vitrine.

---

## 0. Resumo Executivo

| Marco | Entrega | Autonomia |
| :-- | :-- | :-- |
| **M1 — Fundação** | Catálogo mestre auto-construído, de-para item↔SKU, custo/margem líquida real, dicionário de apelidos | `OBSERVE` |
| **M2 — Predição** | Gestão de preços com histórico, vitrine conversacional, estimador de elasticidade, alertas de prejuízo/sortimento | `SUGGEST` |
| **M3 — Otimização** | Otimizador de preço e sortimento por lucro de categoria, índice de preço vs. concorrência, markdown | `ASK` |
| **M4 — Autonomia** | Reajuste automático por custo (margem-alvo), vitrine sempre sincronizada, catálogo compartilhado entre comércios | `EXECUTE` |

**Depende de:** HyperSupplier (custo, NCM), HyperSales (venda por nível de preço), HyperAccounting (regime tributário do SKU), HyperFinancial (taxa média), HyperStock (disponibilidade/validade), coleta externa de preços.
**É consumido por:** HyperSales (preço/itens), HyperStock (SKU/embalagem), HyperMarketing (margem/complementares), HyperAccounting (classificação fiscal), PersonalShopper (preço de lançamento).

---

## 1. Pré-requisitos e Dependências

| Item | Estado | Ação |
| :-- | :-- | :-- |
| `products` CRUD | Existe (`salePriceCents`, `averageCostCents`) | Base do catálogo mestre |
| De-para item do fornecedor | Não existe | Novo `sku_mappings` (com HyperSupplier) |
| Histórico de preço | Não existe | Nova `price_history` |
| Margem líquida real | Só margem bruta implícita | `margin.service.ts` (custo + imposto + taxa) |
| Vitrine conversacional | Não existe | `storefront.service.ts` sobre WhatsZap |
| Coleta de preço de concorrente | Não existe | M3, scraping/coleta manual |

---

## 2. Arquitetura no Repositório

```
src/entities/products/            # renomeável conceitualmente para "commerce"
  types.ts            # + MasterSku, PriceHistoryEntry, MarginBreakdown, AssortmentItem, Bundle, PriceIndex
  repository.ts       # ProductsRepository — estender p/ atributos e listas
  service.ts          # catálogo, apelidos, de-para
  margin.service.ts   # NOVO: margem líquida real
  pricing.service.ts  # NOVO: gestão de preços + histórico + listas por canal
  storefront.service.ts # NOVO: vitrine conversacional
  assortment.service.ts # NOVO: política de sortimento, gaps, itens zumbi
  elasticity/
    estimator.ts      # NOVO: elasticidade-preço por SKU (bayes hierárquico)
  optimizer/
    category-profit.ts# NOVO: preço + sortimento por lucro de categoria
  agent.ts            # CommerceAgent (M4)
src/api/controllers/products.controller.ts   # estender
src/database/migration.ts  +  prisma/schema.prisma
```

**Wiring:** caminho vivo. `CommerceAgent` (M4) reage a `purchase.price.recorded` para reajuste automático.

---

## 3. Modelo de Dados

| Tabela | Colunas-chave |
| :-- | :-- |
| `products` (existe) | `+ brand`, `+ category`, `+ pack_desc`, `+ unit_measure`, `+ ncm`, `+ cest`, `+ tax_regime` (`MONOPHASIC|ST|FULL`), `+ barcode`, `+ assortment_status` (`CORE|TRIAL|ZOMBIE|DROPPED`), `+ target_margin_pct`, `+ max_auto_reprice_pct` |
| `sku_mappings` | `id`, `sku`, `supplier_id`, `supplier_item_desc`, `purchase_pack_qty`, `sale_unit_ratio` |
| `product_aliases` | (compartilhada com HyperSales) `sku`, `alias`, `scope`, `hits` |
| `price_history` | `id`, `sku`, `channel` (`counter|delivery|wallet|wholesale`), `price_cents`, `reason`, `previous_cents`, `effective_at`, `set_by` |
| `margin_breakdown` | `sku`, `channel`, `price_cents`, `cost_cents`, `tax_cents`, `fee_cents`, `net_margin_cents`, `net_margin_pct`, `computed_at` |
| `price_elasticity` | `sku`, `elasticity`, `ci_low`, `ci_high`, `r2`, `samples`, `computed_at` |
| `competitor_prices` | `id`, `sku|category`, `source`, `price_cents`, `observed_at` |
| `bundles` | `id`, `name`, `components jsonb`, `price_cents`, `margin_cents` |
| `category_price_plan` | `id`, `category`, `plan jsonb` (por SKU: preço sugerido, papel), `expected_gain_cents`, `computed_at` |

---

## 4. Contratos de API (REST)

| Método | Rota | Propósito |
| :-- | :-- | :-- |
| `GET` | `/products/:sku/margin` | Margem líquida real por canal |
| `POST` | `/products/:sku/price` | Definir preço (com motivo, histórico) |
| `GET` | `/products/:sku/price-history` | Histórico datado |
| `POST` | `/storefront/query` | Vitrine conversacional (pergunta do cliente) |
| `GET` | `/products/:sku/elasticity` | Elasticidade estimada |
| `POST` | `/pricing/simulate` | Simular reajuste (volume/faturamento/lucro) |
| `GET` | `/assortment/opportunities` | Gaps e itens zumbi |
| `GET` | `/pricing/category-plan/:category` | Plano de preço/sortimento otimizado |
| `POST` | `/bundles` | Criar combo |
| `GET` | `/products/report?q=...` | Relatório de merchandising sob demanda |

---

## 5. Eventos

| Direção | Evento | Payload | Marco |
| :-- | :-- | :-- | :-- |
| Consome | `supplier.price.recorded` | `{ supplierId, sku, unitPriceCents }` | M1 |
| Consome | `purchase.goods.received` | `{ items[] }` | M1 |
| Consome | `sale.confirmed` | `{ items[] (sku, qty, priceCents) }` | M2 |
| Consome | `accounting.tax.classification.updated` | `{ sku, regime }` | M1 |
| Consome | `finance.fees.updated` | `{ avgFeePct }` | M1 |
| Consome | `stock.expiry.forecasted` | `{ sku, atRiskQty }` | M3 |
| Consome | `market.competitor.price.observed` | `{ sku, priceCents, source }` | M3 |
| Emite | `catalog.product.created` / `catalog.product.updated` | `{ sku, attrs }` | M1 |
| Emite | `catalog.price.changed` | `{ sku, priceCents, previousCents, reason }` | M2 |
| Emite | `catalog.margin.updated` | `{ sku, netMarginPct }` | M1 |
| Emite | `catalog.assortment.changed` | `{ sku, status }` | M3 |
| Emite | `catalog.elasticity.estimated` | `{ sku, elasticity }` | M2 |
| Emite | `catalog.loss.flagged` | `{ sku, netMarginCents }` | M1 |
| Emite | `storefront.query.answered` | `{ from, items[] }` | M2 |

---

## 6. Componentes de IA / Otimização

| Capacidade | Tipo | Baseline v1 | Evolução | Libs | Fallback |
| :-- | :-- | :-- | :-- | :-- | :-- |
| Normalização de produto → SKU mestre | LLM + determinístico | Normalizar unidade + LLM extrai marca/categoria; match por `pg_trgm` | Embeddings + base compartilhada | OpenRouter, `pg_trgm` | Cadastro manual |
| Dicionário de apelidos | Determinístico + LLM | Registrar termo → SKU no uso real; LLM sugere sinônimos | Aprendizado por comerciante/cliente | OpenRouter | Perguntar |
| Margem líquida real | Determinístico | `preço − custo médio móvel − imposto(regime) − taxa média` | Taxa por bandeira real | — | Margem bruta |
| Elasticidade-preço | IA especializada | Regressão log-log de demanda por SKU, controlando sazonalidade/promoção | Bayes hierárquico (pooling entre SKUs parecidos) | `simple-statistics`; Python depois | "sem dados suficientes" |
| Simulação de reajuste | IA especializada | Aplicar elasticidade → Δvolume, Δfaturamento, Δlucro com bandas | — | — | Só recalcular margem |
| Otimizador preço+sortimento por categoria | Otimização não-linear | LP/heurística: maximizar Σ(margem×volume) com preço do âncora ≤ referência, espaço, teto de variação | Elasticidades cruzadas (canibalização) | `javascript-lp-solver` + busca local | Reajuste item-a-item |
| Índice de preço vs. concorrência | Determinístico | Média ponderada dos `competitor_prices` por categoria | Ajuste por reputação da fonte | — | Não exibir |
| Relatório sob demanda | LLM + SQL | NL → consulta | — | OpenRouter | Fixos |

**Autoridade:** `pricing.service.ts.applyReprice()` só executa reajuste automático dentro de `max_auto_reprice_pct` e nunca abaixo do custo líquido sem override registrado.

---

## 7. Integrações Externas

- **WhatsZap MCP:** vitrine conversacional, alertas de prejuízo/preço, definição de preço por áudio, relatórios.
- **Coleta de preço de concorrente (M3):** scraping respeitando termos / entrada manual por áudio / marketplaces com API.
- **OpenRouter:** LLM de normalização e relatório.
- **Dependências internas:** HyperSupplier (custo), HyperAccounting (regime), HyperFinancial (taxa).

---

## 8. Roadmap de Entregas

### Marco 1 — Fundação (`OBSERVE`) — ~2–3 sprints
1. Estender `products` com atributos; `sku_mappings`; `product_aliases` (compartilhada).
2. `service.ts`: criar SKU a partir de `purchase.goods.received` / inventário; normalização LLM; dedup.
3. `margin.service.ts` + `margin_breakdown`; `catalog.margin.updated`; `catalog.loss.flagged`.
4. `price_history` (toda mudança de preço datada e motivada).
   **Pronto quando:** cada compra cria/atualiza SKU e recalcula a margem líquida real; item no prejuízo é sinalizado.

### Marco 2 — Predição (`SUGGEST`) — ~3 sprints
1. `pricing.service.ts`: listas por canal, definição por áudio.
2. `storefront.service.ts`: `POST /storefront/query` (disponibilidade real + preço do canal).
3. `elasticity/estimator.ts` (baseline log-log); `pricing/simulate`.
4. Alertas de prejuízo e de gap de sortimento via WhatsZap.
   **Pronto quando:** cliente consulta a vitrine por conversa; comerciante recebe "reajuste sugerido: R$ X, previsão −6% volume, +R$ 74/mês".

### Marco 3 — Otimização (`ASK`) — ~3 sprints
1. `competitor_prices` + índice de preço.
2. `optimizer/category-profit.ts`: `GET /pricing/category-plan/:category`.
3. `assortment.service.ts`: gaps, itens zumbi, `catalog.assortment.changed`.
4. Markdown otimizado para itens perto do vencimento (com HyperStock).
   **Pronto quando:** o sistema entrega um plano de preços+sortimento por categoria para aprovação de 1 toque.

### Marco 4 — Autonomia (`EXECUTE`) — ~1–2 sprints
1. `CommerceAgent`: reajuste automático ao mudar o custo, preservando `target_margin_pct`, dentro de `max_auto_reprice_pct`.
2. Vitrine sempre sincronizada (evento-driven).
3. Catálogo compartilhado entre comércios (ficha/NCM/imagem; nunca preço/custo).
   **Pronto quando:** custo sobe → preço se ajusta sozinho e a vitrine reflete na hora.

---

## 9. Estratégia de Testes

- **Unit:** normalização/dedup, cálculo de margem líquida, aplicação de elasticidade, LP de categoria (casos conhecidos), guarda de `max_auto_reprice_pct`.
- **Integração:** Postgres real — compra→SKU→margem→histórico; consulta de vitrine com estoque real.
- **E2E:** áudio "cachaça nova a 12" → SKU + preço + vitrine; `purchase.price.recorded` → reajuste automático.
- **Backtest:** elasticidade avaliada por *holdout* de períodos; métrica: erro de previsão de volume pós-reajuste, R² da curva, ganho de margem simulado vs. real.

---

## 10. Métricas de Sucesso

| Marco | Métrica | Alvo |
| :-- | :-- | :-- |
| M1 | SKUs com margem líquida real calculada | 100% |
| M1 | Itens vendidos abaixo do custo | 0 (após sinalização) |
| M2 | Consultas de vitrine respondidas corretamente | ≥ 95% |
| M2 | R² médio da elasticidade (SKUs classe A) | ≥ 0,5 |
| M3 | Ganho de margem pelo otimizador de categoria | +3% a +12% |
| M4 | Defasagem preço↔custo após alta de custo | < 24 h |

---

## 11. Riscos e Mitigação

| Risco | Impacto | Mitigação |
| :-- | :-- | :-- |
| Poucos pontos de preço no histórico | Elasticidade não identificável | Pooling hierárquico; usar categoria; não sugerir sem CI aceitável |
| Reajuste automático assusta o cliente | Perda de venda | `max_auto_reprice_pct` conservador; só em alta de custo; avisar o comerciante |
| Coleta de concorrente frágil/ilegal | Índice ruim / risco | Só fontes com API ou entrada manual; marcar confiança |
| Divergência NCM cupom × base oficial | Tributo errado (HyperAccounting) | Validar na base oficial; bloquear venda só se afetar tributo |
| SKU duplicado | Margem/estoque errados | Dedup na criação + merge auditável |

---

## 12. Checklist de Implementação

- [ ] Atributos em `products` + `sku_mappings` + `product_aliases`
- [ ] Criação de SKU por compra/inventário + normalização LLM + dedup
- [ ] `margin.service.ts` + `margin_breakdown` + `catalog.loss.flagged`
- [ ] `price_history` (datado, motivado)
- [ ] `pricing.service.ts` (listas por canal, preço por áudio)
- [ ] `storefront.service.ts` + `POST /storefront/query`
- [ ] `elasticity/estimator.ts` + `pricing/simulate`
- [ ] Alertas de prejuízo / gap de sortimento
- [ ] `competitor_prices` + índice de preço
- [ ] `optimizer/category-profit.ts`
- [ ] `assortment.service.ts` (zumbi/gaps) + markdown
- [ ] `CommerceAgent`: reajuste automático dentro do teto
- [ ] Catálogo compartilhado entre comércios
- [ ] Testes unit + integração + e2e + backtest
