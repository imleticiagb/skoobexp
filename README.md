# Skoob Exporter

Extensão do Chrome que exporta **toda** a sua estante do Skoob (livros, avaliações,
resenhas, datas e etiquetas) para um CSV no formato de exportação do **Goodreads**,
que é o formato que o Maratona e outros apps de leitura importam.

## Instalação (uma vez só)

1. Abra `chrome://extensions` no Chrome (ou Edge/Brave).
2. Ative o **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação** e escolha a pasta `extension/` deste projeto.

## Como usar

1. Entre no [skoob.com.br](https://www.skoob.com.br) e faça login normalmente.
2. Com a aba do Skoob aberta, clique no ícone da extensão (fixe-a pelo ícone de
   quebra-cabeça se não aparecer). Um painel abre no canto da página.
3. Clique em **Exportar estante**. Para ~300 livros leva cerca de 2 minutos.
   Não feche a aba nem saia da página enquanto roda.
4. O arquivo `skoob_goodreads_export_AAAA-MM-DD.csv` é baixado.
5. No Maratona, use a opção de importar do Goodreads e escolha esse arquivo.
   Não abra e salve o CSV no Excel antes de importar: ele estraga ISBNs e datas.

A extensão usa a sessão já logada no navegador, então não pede nem guarda sua senha.

## De onde vem cada coluna

| Coluna | Origem no Skoob |
|---|---|
| Title, Publisher, Number of Pages, Year Published | estante |
| Author / Author l-f | autor principal da estante ("Bradbury, Ray") |
| Additional Authors | demais autores listados na página do livro |
| ISBN, ISBN13 | página do livro; se não houver ISBN válido, veja "Livros sem ISBN" abaixo |
| My Rating | sua nota (0 = sem nota) |
| Date Read | data de término da leitura, quando preenchida |
| Date Added | "Adicionou à estante" (jornada de leitura) |
| Exclusive Shelf | Lido → `read`, Lendo/Relendo → `currently-reading`, Quero ler → `to-read`, Abandonei → `did-not-finish` (configurável) |
| Bookshelves (+ positions) | prateleira exclusiva + etiquetas: Favorito → `favorites`, Tenho → `owned`, Desejado → `wishlist`, Troco → `to-trade`, Emprestei → `lent` |
| My Review / Spoiler | título + texto da resenha / marcação de spoiler |
| Read Count | 1 para lidos, 0 para os demais |
| Owned Copies | 1 se marcado como "Tenho" |
| Binding, Original Publication Year, Private Notes | vazios (o Skoob não tem esses dados) |

## Livros sem ISBN

Todos os livros da estante vão para o CSV, com ou sem ISBN. Quando a edição no
Skoob não tem ISBN válido (comum em ebooks, que trazem o código ASIN da Amazon no
lugar), a extensão procura nesta ordem e para na primeira que encontrar:

1. Outras edições do mesmo livro no Skoob (prefere mesmo volume, mesma editora e português).
2. Busca do Skoob por título + autor (só aceita mesmo título, mesmo autor e mesmo volume).
3. Open Library (prefere edição em português).
4. Google Books (a cota pública anônima costuma estar esgotada; se der erro, é ignorado).

O painel mostra de onde veio cada ISBN encontrado. Livros que não existem com
ISBN em lugar nenhum (lançamentos futuros, webtoons, ebooks só da Amazon) vão
sem ISBN e o Maratona tenta reconhecê-los por título e autor.

## Opções do painel

- **Arredondar meias estrelas**: o Goodreads só aceita notas inteiras (3,5 vira 4).
  Desmarque para manter decimais, caso o Maratona aceite.
- **Quebras de linha como `<br/>`**: é o padrão do Goodreads. Se as resenhas
  aparecerem com `<br/>` escrito no Maratona, desmarque e exporte de novo.
- **ISBN no formato `="…"`**: é o padrão do Goodreads (evita que planilhas
  apaguem zeros). Desmarque se o Maratona não reconhecer os ISBNs.
- **Prateleira para "Abandonei"**: nome da prateleira exclusiva dos abandonados.

## Como funciona

- Estante: `GET https://prd-api.skoob.com.br/api/v1/bookshelf?filter=all` (paginado),
  autenticado com o JWT do cookie `tokenClient` do Skoob (o mesmo que o site usa).
- Etiquetas: o mesmo endpoint com `filter=favorited|owned|desired|traded|lent`.
- Resenhas: `GET /v1/feed/personal?type=review`.
- ISBN, coautores, data de adição e outras edições: dados embutidos em `/pt/book/<edition_id>`.
- Busca de livros: `GET /v1/search/book?search_term=...`.

Se o Skoob mudar o site de novo, os pontos mais prováveis de quebrar são
`parseBookPage` em [extension/goodreads.js](extension/goodreads.js) e as URLs em
[extension/content.js](extension/content.js).
