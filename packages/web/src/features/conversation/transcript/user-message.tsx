import { splitFileBlocks, type UserMessage } from "@pi-code/protocol";
import { FileTextIcon } from "lucide-react";
import { useState } from "react";
import { CollapsibleRow } from "@/components/collapsible-row";
import { CodeRefText } from "@/features/review/code-ref-text";
import { baseName, contentImages, contentText, imageSrc } from "@/lib/content";
import { cn } from "@/lib/utils";

/**
 * A full-width box: image thumbnails, then leading `<file>` blocks (attached text files) as
 * collapsed rows that expand to the file's content, then the text (content may be a string or a
 * content array). Line references in the text are clickable.
 */
export function UserMessageView({
  message,
  pending = false,
}: {
  message: Pick<UserMessage, "content">;
  pending?: boolean;
}) {
  const { files, body } = splitFileBlocks(contentText(message.content));
  const images = contentImages(message.content);
  const [zoomed, setZoomed] = useState<number | null>(null);
  return (
    <div
      data-testid="user-message"
      className={cn(
        "flex w-full min-w-0 flex-col gap-2 rounded-[10px] border bg-user-message px-[15px] pt-[11px] pb-3 text-prose text-foreground",
        pending && "opacity-70",
      )}
    >
      {images.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {images.map((image, index) => (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: images have no id
              key={index}
              type="button"
              onClick={() => setZoomed(zoomed === index ? null : index)}
              aria-label={`Image ${index + 1}`}
            >
              <img
                src={imageSrc(image)}
                alt={`Attachment ${index + 1}`}
                className={cn(
                  "rounded-md object-cover",
                  zoomed === index ? "max-h-96 w-full object-contain" : "size-20",
                )}
              />
            </button>
          ))}
        </div>
      )}
      {files.map((file, index) => (
        <CollapsibleRow
          // biome-ignore lint/suspicious/noArrayIndexKey: file blocks have no id
          key={index}
          data-testid="file-attachment"
          icon={<FileTextIcon />}
          label={
            <span title={file.name} className="truncate">
              {baseName(file.name)}
            </span>
          }
        >
          <pre className="mt-0.5 mb-1 max-h-64 overflow-auto rounded-lg border bg-card px-3 py-2 font-mono text-xs">
            {file.text}
          </pre>
        </CollapsibleRow>
      ))}
      {body !== "" && (
        <div className="whitespace-pre-wrap break-words">
          <CodeRefText text={body} />
        </div>
      )}
    </div>
  );
}
