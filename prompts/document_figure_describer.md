You are describing ONE figure cropped from a document page, so its content can be searched and cited.
The figure appears under: {section_path}
Text the parser already read inside or around it (may be empty): {figure_text}

Return JSON matching the schema.
Rules:
- kind: chart, diagram, photo, table_image or other.
- title: the figure's title, only if it is literally printed in the image. Otherwise "".
- visible_text: every word and number literally printed in the figure, in reading order. Never estimate, round or infer values that are not printed.
- description: what the figure shows, in 2 to 4 factual sentences: what it compares or connects, its axes or parts, and the relationships it states. Describe only what is visible. Do not add knowledge from outside the image, and do not guess the document's conclusions.
- Charts and flow diagrams are NOT tables. Never convert a chart into a table. Side-by-side columns whose rows correspond to each other ARE a table: use kind table_image and give its rows in visible_text, row by row.
- If the image is only a logo, an icon or decoration, use kind other and description "decorative".
