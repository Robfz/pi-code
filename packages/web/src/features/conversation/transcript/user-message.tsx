import {
  type PrBlock,
  type SkillBlock,
  splitFileBlocks,
  splitPrBlocks,
  splitSkillBlock,
  type UserMessage,
} from "@pi-code/protocol";
import { BotIcon, FileTextIcon, GitPullRequestIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";
import { CollapsibleRow } from "@/components/collapsible-row";
import { Markdown } from "@/components/markdown";
import { CodeRefText } from "@/features/review/code-ref-text";
import { baseName, contentImages, contentText, imageSrc } from "@/lib/content";
import { cn } from "@/lib/utils";

/** A `<pr>` block (the context `/pr` sent, or a refresh's update) as a card: `#N title`, state. */
function PrCard({ pr }: { pr: PrBlock }) {
  return (
    <CollapsibleRow
      data-testid="pr-card"
      icon={<GitPullRequestIcon />}
      label={
        <>
          <span className="shrink-0 font-mono text-link">#{pr.number}</span>
          <span title={pr.title} className="truncate">
            {pr.title}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {pr.update ? `updated · ${pr.state}` : pr.state}
          </span>
        </>
      }
    >
      <pre className="mt-0.5 mb-1 max-h-64 overflow-auto rounded-lg border bg-card px-3 py-2 font-mono text-xs whitespace-pre-wrap">
        {pr.text}
      </pre>
    </CollapsibleRow>
  );
}

/**
 * An expanded `/skill:name` command as a row that expands to the skill's text. Ultraspawn's skill
 * takes the look of ultraspawn tool rows.
 */
function SkillCard({ skill }: { skill: SkillBlock }) {
  const ultraspawn = skill.name === "ultraspawn";
  const Icon = ultraspawn ? BotIcon : SparklesIcon;
  return (
    <CollapsibleRow
      data-testid="skill-invocation"
      icon={<Icon className={cn(ultraspawn && "text-ultraspawn")} />}
      label={
        <span title={skill.location} className={cn("truncate", ultraspawn && "text-ultraspawn")}>
          /skill:{skill.name}
        </span>
      }
    >
      <div className="mt-0.5 mb-1 max-h-64 overflow-auto rounded-lg border bg-card px-3 py-2">
        <Markdown text={skill.content} />
      </div>
    </CollapsibleRow>
  );
}

/**
 * A full-width box: image thumbnails, then a leading `<skill>` block (an expanded `/skill:name`)
 * as a skill card, then leading `<file>` blocks (attached text files) as collapsed rows that
 * expand to the file's content, then leading `<pr>` blocks (PR review's context) as PR cards, then
 * the text (content may be a string or a content array). Line references in the text are
 * clickable.
 */
export function UserMessageView({
  message,
  pending = false,
}: {
  message: Pick<UserMessage, "content">;
  pending?: boolean;
}) {
  // The composer keeps a skill command ahead of attached files, so pi's skill block comes first.
  const { skill, body: args } = splitSkillBlock(contentText(message.content));
  const { files, body: rest } = splitFileBlocks(args);
  const { prs, body } = splitPrBlocks(rest);
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
      {skill && <SkillCard skill={skill} />}
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
      {prs.map((pr, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: PR blocks have no id
        <PrCard key={index} pr={pr} />
      ))}
      {body !== "" && (
        <div className="whitespace-pre-wrap break-words">
          <CodeRefText text={body} />
        </div>
      )}
    </div>
  );
}
