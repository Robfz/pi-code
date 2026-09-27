import type { UserMessage } from "@pi-code/protocol";
import { useState } from "react";
import { contentImages, contentText, imageSrc } from "@/lib/content";
import { cn } from "@/lib/utils";

/** User text + image thumbnails (content may be a string or a content array). */
export function UserMessageView({
  message,
  pending = false,
}: {
  message: Pick<UserMessage, "content">;
  pending?: boolean;
}) {
  const text = contentText(message.content);
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
      {text !== "" && <div className="whitespace-pre-wrap break-words">{text}</div>}
    </div>
  );
}
