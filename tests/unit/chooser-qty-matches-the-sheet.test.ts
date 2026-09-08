/**
 * MEAL-218 was fixed in one component and not the other.
 *
 * WebViewCartSheet stopped greeting people in red on 2026-09-05.
 * ProductChooserSheet kept doing it: label red, number red, and a literal "0"
 * that reads as a quantity someone chose. It was found by driving a Ralphs run
 * on the Pixel and looking at the screen, not by reading the diff.
 *
 * A source check, said plainly. Both screens render a quantity stepper in a
 * footer, and what matters is that they agree; asserting that in a render test
 * would need the chooser's whole Kroger fixture for a question about colour.
 */
import * as fs from 'fs';
import * as path from 'path';

const read = (f: string) =>
  fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'components', f), 'utf8');

const CHOOSER = read('ProductChooserSheet.tsx');

describe('the product chooser follows the same rule as the cart sheet', () => {
  it('does not paint the label red when nothing has been chosen yet', () => {
    // The exact shape that used to greet everyone.
    expect(CHOOSER).not.toMatch(/qtyLabel,\s*productQty === 0 && \{ color: '#ef4444' \}/);
  });

  it('does not paint the NUMBER the error red either', () => {
    expect(CHOOSER).not.toMatch(/qtyNum,\s*productQty === 0 && \{ color: '#ef4444' \}/);
  });

  it('shows the unset placeholder rather than a literal zero', () => {
    // "0" reads as a value someone picked. The dash says nothing is picked.
    expect(CHOOSER).toContain('qtyDisplay(productQty)');
  });

  it('wears the same amber ring, not a second invention', () => {
    expect(CHOOSER).toContain('rgba(245,158,11,0.25)');
    expect(CHOOSER).toContain('testID="chooser-qty-glow"');
  });

  it('uses amber and never a red for the resting glow', () => {
    // Both reds are refused by value: the error red and the brand red, which is
    // rgb(221,0,49) and would reintroduce the greeting in a different shade.
    const glow = CHOOSER.slice(CHOOSER.indexOf('qtyIdleBorder = '), CHOOSER.indexOf('qtyIdleBg = ') + 200);
    expect(glow).not.toMatch(/239,\s*68,\s*68/);
    expect(glow).not.toMatch(/221,\s*0,\s*49/);
  });
});
