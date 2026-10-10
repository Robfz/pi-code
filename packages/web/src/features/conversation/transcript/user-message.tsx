import { splitFileBlocks, type UserMessage } from "@pi-code/protocol";
import { FileTextIcon } from "lucide-react";
import { useState } from "react";
import { CodeRefText } from "@/features/review/code-ref-text";
import { baseName, contentImages, contentText, imageSrc } from "@/lib/content";
import { cn } from "@/lib/utils";

/**
 * User text + image thumbnails (content may be a string or a content array). Leading `<file>`
 * blocks (attached text files) render as collapsed chips that expand to the file's content. Line
 * references in the text are clickable.
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
        "ml-auto flex max-w-[92%] flex-col gap-2 rounded-2xl rounded-br-sm bg-secondary px-3 py-2 text-sm text-secondary-foreground",
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
        <details
          // biome-ignore lint/suspicious/noArrayIndexKey: file blocks have no id
          key={index}
          data-testid="file-attachment"
          className="min-w-0 rounded-md border bg-background/50"
        >
          <summary
            title={file.name}
            className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1 text-xs select-none"
          >
            <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate font-mono">{baseName(file.name)}</span>
          </summary>
          <pre className="max-h-64 overflow-auto border-t px-2 py-1.5 font-mono text-xs">
            {file.text}
          </pre>
        </details>
      ))}
      {body !== "" && (
        <div className="whitespace-pre-wrap break-words">
          <CodeRefText text={body} />
        </div>
      )}
    </div>
  );
}
