import { useEffect, useState } from 'react';
import { Download, Plus, Type } from 'lucide-react';
import type { FontDesign } from '../../../shared/visual-design.ts';
import { Button, Field, Input, Select } from '../../components/ui.tsx';
import { download } from '../../lib.ts';
import { buildTrueType, gridGlyph } from './typeface.ts';
import PathDesigner from './PathDesigner.tsx';

export default function FontDesigner({
  design,
  onChange,
  onApply,
  canApply,
  readOnly,
  onError,
}: {
  design: FontDesign;
  onChange: (next: FontDesign) => void;
  onApply: () => void;
  canApply: boolean;
  readOnly: boolean;
  onError: (message: string) => void;
}) {
  const [character, setCharacter] = useState('A'),
    [newCharacter, setNewCharacter] = useState(''),
    [preview, setPreview] = useState('STUDIO 0123'),
    [faceName, setFaceName] = useState('Inter');
  const glyph =
    design.glyphs.find((g) => g.character === character) ?? design.glyphs[0]!;
  useEffect(() => {
    let active = true,
      font: FontFace | undefined;
    try {
      const bytes = buildTrueType(design);
      font = new FontFace(
        'DesignedPreview-' + crypto.randomUUID(),
        new Uint8Array(bytes).buffer,
      );
      void font
        .load()
        .then((loaded) => {
          if (active) {
            document.fonts.add(loaded);
            setFaceName(loaded.family);
          }
        })
        .catch(() => {
          if (active)
            onError(
              'The generated typeface could not be previewed. Check the glyph outlines.',
            );
        });
    } catch (error) {
      onError((error as Error).message);
    }
    return () => {
      active = false;
      if (font) document.fonts.delete(font);
    };
  }, [design]);
  const changeGlyph = (patch: Partial<typeof glyph>) =>
    onChange({
      ...design,
      glyphs: design.glyphs.map((g) =>
        g.character === glyph.character ? { ...g, ...patch } : g,
      ),
    });
  return (
    <section className="font-designer" aria-label="Typeface designer">
      <div className="font-designer-header">
        <div>
          <h2>Typeface designer</h2>
          <p>
            Author outlines and spacing. Export an installable TrueType font.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            try {
              download(
                `${design.family}.ttf`,
                new Blob([new Uint8Array(buildTrueType(design)).buffer], {
                  type: 'font/ttf',
                }),
                'font/ttf',
              );
            } catch (error) {
              onError((error as Error).message);
            }
          }}
        >
          <Download size={13} />
          Export TTF
        </Button>
      </div>
      <div className="font-designer-fields">
        <Field label="Font family">
          <Input
            aria-label="Designed font family"
            value={design.family}
            maxLength={80}
            disabled={readOnly}
            onChange={(e) => {
              if (/^[\p{L}\p{N} ._-]+$/u.test(e.target.value))
                onChange({ ...design, family: e.target.value });
            }}
          />
        </Field>
        <Field label="Character">
          <Select
            aria-label="Glyph character"
            value={glyph.character}
            onChange={(e) => setCharacter(e.target.value)}
          >
            {design.glyphs.map((g) => (
              <option key={g.character} value={g.character}>
                {g.character === ' ' ? 'Space' : g.character} · U+
                {g.character
                  .charCodeAt(0)
                  .toString(16)
                  .padStart(4, '0')
                  .toUpperCase()}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Advance width">
          <Input
            aria-label="Glyph advance width"
            type="number"
            min={100}
            max={2000}
            value={glyph.advanceWidth}
            disabled={readOnly}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (n >= 100 && n <= 2000)
                changeGlyph({ advanceWidth: Math.round(n) });
            }}
          />
        </Field>
      </div>
      <div className="font-new-glyph">
        <Input
          aria-label="New glyph character"
          value={newCharacter}
          maxLength={1}
          disabled={readOnly}
          placeholder="Character"
          onChange={(e) => setNewCharacter(e.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={
            readOnly ||
            !newCharacter ||
            design.glyphs.length >= 128 ||
            design.glyphs.some((g) => g.character === newCharacter) ||
            newCharacter.charCodeAt(0) < 32 ||
            newCharacter.charCodeAt(0) >= 0xd800
          }
          onClick={() => {
            onChange({
              ...design,
              glyphs: [...design.glyphs, gridGlyph(newCharacter)],
            });
            setCharacter(newCharacter);
            setNewCharacter('');
          }}
        >
          <Plus size={13} />
          Add glyph
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={readOnly || !canApply}
          onClick={onApply}
        >
          <Type size={13} />
          Use in selected text
        </Button>
      </div>
      <PathDesigner
        key={glyph.character}
        value={{
          viewWidth: 1000,
          viewHeight: 1000,
          closed: true,
          contours: glyph.contours.map((c) =>
            c.map((p) => ({ ...p, y: 800 - p.y })),
          ),
        }}
        label={`Glyph ${glyph.character === ' ' ? 'space' : glyph.character}`}
        baseline={800}
        readOnly={readOnly}
        fill="#24292e"
        onChange={(path) =>
          changeGlyph({
            contours: path.contours.map((c) =>
              c.map((p) => ({ ...p, y: 800 - p.y })),
            ),
          })
        }
      />
      <div className="font-specimen">
        <Field label="Typeface specimen">
          <Input
            aria-label="Typeface specimen"
            value={preview}
            maxLength={120}
            onChange={(e) => setPreview(e.target.value)}
          />
        </Field>
        <output
          aria-label="Generated font preview"
          style={{ fontFamily: `"${faceName}"`, fontSize: 40 }}
        >
          {preview}
        </output>
        <p>
          1000 units/em · ascender 800 · descender −200 · {design.glyphs.length}{' '}
          authored glyphs. Unsupported characters use the font’s missing-glyph
          outline.
        </p>
      </div>
    </section>
  );
}
