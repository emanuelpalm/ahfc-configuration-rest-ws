import * as apes from "../apes";
import * as verify from "../util/verify";

/**
 * A configuration document.
 */
export class Document implements apes.Writable {
    public readonly isWritable = true;

    /**
     * Creates new configuration document.
     * 
     * @param template The name of the template used to create this document. 
     * @param name Name of document.
     * @param body Document contents.
     */
    public constructor(
        public readonly template: string,
        public readonly name: string,
        public readonly body: object,
    ) {
        if (template.endsWith(".")) {
            throw new Error(
                "Document template name not fully qualified: " + template
            );
        }
        if (name.endsWith(".")) {
            throw new Error(
                "Document name not fully qualified: " + name
            );
        }
    }

    /**
     * Attempts to create new document from given source object.
     *
     * @param source Object to build document from.
     * @return New document.
     */
    public static read(source: object): Document {
        return new Document(
            verify.isString(source["TemplateName"]),
            verify.isString(source["DocumentName"]),
            verify.isObject(source["Body"]),
        );
    }

    public write(writer: apes.Writer) {
        writer.writeMap(writer => writer
            .addText("TemplateName", this.template)
            .addText("DocumentName", this.name)
            .add("Body", this.body));
    }
}