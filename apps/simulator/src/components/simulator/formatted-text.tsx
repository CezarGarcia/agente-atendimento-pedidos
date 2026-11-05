import { Fragment } from 'react';

/** Renderiza o negrito do WhatsApp (*texto*) e quebras de linha, sem HTML arbitrário. */
export function FormattedText({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((line, lineIndex) => (
        <Fragment key={lineIndex}>
          {lineIndex > 0 && <br />}
          {line.split(/(\*[^*\n]+\*)/g).map((part, partIndex) =>
            /^\*[^*]+\*$/.test(part) ? (
              <strong key={partIndex} className="font-semibold">
                {part.slice(1, -1)}
              </strong>
            ) : (
              <Fragment key={partIndex}>{part}</Fragment>
            ),
          )}
        </Fragment>
      ))}
    </>
  );
}
