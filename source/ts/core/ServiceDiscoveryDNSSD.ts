import * as crypto from "crypto";
import * as ddns from "./ddns";
import * as os from "os";
import {
    ServiceDiscovery,
    ServiceType,
    ServiceIdentifier,
    ServiceRecord
} from "./ServiceDiscovery";

/**
 * Provides a `ServiceDiscovery` implementation based on the DNS-SD protocol.
 */
export class ServiceDiscoveryDNSSD implements ServiceDiscovery {
    private readonly resolver: ddns.Resolver;

    private readonly browsingDomains: () => Promise<string[]>;
    private readonly registrationDomains: () => Promise<string[]>;
    private readonly hostnames: () => Promise<string[]>;

    /**
     * Creates new DNS-SD `ServiceDiscovery` instance.
     * 
     * @param configuration DNS-SD configuration.
     */
    public constructor(configuration: ServiceDiscoveryDNSSDConfiguration = {}) {
        this.resolver = new ddns.Resolver(configuration.nameServerAddresses);

        if (configuration.browsingDomains) {
            const domains = configuration.browsingDomains.slice();
            this.browsingDomains = () => Promise.resolve(domains);
        } else {
            this.browsingDomains = () => this.hostnames()
                .then(domains => this.resolver.resolvePTRs(domains
                    .map(domain => "b._dns-sd._udp." + domain)))
                .then(results => this.removeAndLogAnyErrors(results));
        }

        if (configuration.registrationDomains) {
            const domains = configuration.registrationDomains.slice();
            this.registrationDomains = () => Promise.resolve(domains);
        } else {
            this.registrationDomains = () => this.hostnames()
                .then(domains => this.resolver.resolvePTRs(domains
                    .map(domain => "r._dns-sd._udp." + domain)))
                .then(results => this.removeAndLogAnyErrors(results));
        }

        if (configuration.hostnames) {
            const hostnames = configuration.hostnames.slice();
            this.hostnames = () => Promise.resolve(hostnames);
        } else {
            this.hostnames = () =>
                this.resolver.reverseAll(externalNetworkInterfaceAddresses())
                    .then(results => this.removeAndLogAnyErrors(results))
                    .then(names => names.reduce((hostnames, name) => {
                        const index = name.indexOf(".");
                        if (index >= 0) {
                            hostnames.push(name.substring(index + 1));
                        }
                        return hostnames;
                    }, new Array<string>()));

        }

        function externalNetworkInterfaceAddresses(): string[] {
            const nifGroups = os.networkInterfaces();
            return Object.getOwnPropertyNames(nifGroups)
                .map(nifGroupName => nifGroups[nifGroupName])
                .reduce((addresses, nifGroup) => {
                    nifGroup.forEach(nif => {
                        if (!nif.internal) {
                            addresses.push(nif.address);
                        }
                    });
                    return addresses;
                }, new Array<string>());
        }
    }

    private removeAndLogAnyErrors<T>(results: Array<T | Error>): T[] {
        return results.reduce((browsingDomains, result) => {
            if (result instanceof Error) {
                console.log(result); // TODO: Proper logger.
            } else {
                browsingDomains.push(result);
            }
            return browsingDomains;
        }, []);
    }

    public lookupTypes(): Promise<ServiceType[]> {
        return this.browsingDomains()
            .then(domains => this.resolver.resolvePTRs(domains
                .map(domain => "_services._dns-sd._udp." + domain)))
            .then(results => this.removeAndLogAnyErrors(results))
            .then(types => types.map(type => new ServiceTypeDNSSD(type)));
    }

    public lookupIdentifiers(type: ServiceType): Promise<ServiceIdentifier[]> {
        return this.resolver.resolvePTR(type.toString())
            .then(rdata => rdata.map(item => new ServiceIdentifierDNSSD(item)));
    }

    public lookupRecord(identifier: ServiceIdentifier): Promise<ServiceRecord> {
        const hostname = identifier.toString();
        return Promise.all([
            this.resolver.resolveSRV(hostname),
            this.resolver.resolveTXT(hostname)])
            .then(([srv, txt]) => new ServiceRecordDNSSD(identifier, srv, txt));
    }

    public publish(record: ServiceRecord): Promise<void> {
        // TODO: Registration domains? What?
        // TODO: TSIG?

        const domain = record.hostname;
        const services = "_services._dns-sd._udp." + domain;
        const type = record.serviceType + "." + domain;
        const name = record.serviceName + "." + type;

        const ttl = 3600; // TODO: What? How long?

        const updates = [
            new ddns.ResourceRecord(services, ddns.Type.PTR, ddns.DClass.IN,
                ttl, new ddns.PTR(type)),
            new ddns.ResourceRecord(type, ddns.Type.PTR, ddns.DClass.IN, ttl,
                new ddns.PTR(name)),
            new ddns.ResourceRecord(name, ddns.Type.SRV, ddns.DClass.IN, ttl,
                new ddns.SRV(0, 0, record.port, record.endpoint)),
            new ddns.ResourceRecord(name, ddns.Type.TXT, ddns.DClass.IN, ttl,
                ddns.TXT.fromAttributes(record.metadata))
        ];

        let last = 0, current;
        while ((current = record.serviceType.indexOf(".", last)) >= 0) {
            const hostname = record.serviceType.substring(last) + "." + domain;
            updates.push(new ddns.ResourceRecord(hostname, ddns.Type.PTR,
                ddns.DClass.IN, ttl, new ddns.PTR(name)));
            last = current + 1;
        }

        return this.resolver.send(ddns.Message.newUpdateBuilder()
            .zone(domain)
            .absent(name)
            .update(...updates)
            .build())
            .then(response => undefined);
    }

    public unpublish(record: ServiceRecord): Promise<void> {
        throw new Error("Method not implemented.");
    }
}

/**
 * Options for creating `ServiceDiscoveryDNSSD` instances.
 */
export interface ServiceDiscoveryDNSSDConfiguration {
    /**
     * DNS-SD browsing domains.
     * 
     * If not given, browsing domains will be discovered using `hostnames`.
     */
    browsingDomains?: string[];

    /**
     * DNS-SD registration domains.
     * 
     * If not given, registration domains will be discovered using `hostnames`.
     */
    registrationDomains?: string[];

    /**
     * Relevant domain name server hostnames.
     * 
     * If not given, DNS hostnames are resolved by doing reverse DNS lookups on
     * the addresses of any local network interfaces, and then removing the
     * least significant local hostname labels. If the local network interface
     * "eth0" has IPv4 address 192.168.0.2 and a reverse DNS lookup yields
     * "node2.example.arrowhead.eu", then "example.arrowhead.eu" will be used as
     * hostname. Note, however, that the use of VPN tunnels or other kinds of
     * virtual network interfaces may lead to some hostnames not being resolved.
     */
    hostnames?: string[];

    /**
     * Addresses of used DNS/DNS-SD servers.
     *
     * If not given, any DNS servers provided by the system will be used.
     */
    nameServerAddresses?: string[];
}

class ServiceTypeDNSSD implements ServiceType {
    public hostname: string;
    public serviceType: string;

    constructor(data: string | ServiceType) {
        if (typeof data === "string") {
            let i = data.length - 1;
            while (data.charAt(i) === ".") {
                i--;
            }
            data = data.substring(0, i + 1);

            let divider = data.length;
            for (i = divider; i-- > 0;) {
                if (data.charAt(i) === ".") {
                    if (data.charAt(i + 1) === "_") {
                        break;
                    } else {
                        divider = i;
                    }
                }
            }
            this.hostname = data.substring(divider + 1);
            this.serviceType = data.substring(0, divider);
        } else {
            this.hostname = data.hostname;
            this.serviceType = data.serviceType;
        }
    }

    public toString(): string {
        return this.serviceType + "." + this.hostname + ".";
    }
}

class ServiceIdentifierDNSSD extends ServiceTypeDNSSD implements ServiceIdentifier {
    public serviceName: string;

    constructor(data: string | ServiceIdentifier) {
        super(data);

        if (typeof data === "string") {
            let offset = this.serviceType.indexOf(".");
            this.serviceName = this.serviceType.substring(0, offset);
            this.serviceType = this.serviceType.substring(offset + 1);
        } else {
            this.serviceName = data.serviceName;
        }
    }

    public toString(): string {
        return this.serviceName + "." + super.toString();
    }
}

class ServiceRecordDNSSD extends ServiceIdentifierDNSSD implements ServiceRecord {
    public endpoint: string;
    public port: number;
    public metadata;

    constructor(id: ServiceIdentifier, srvs: ddns.SRV[], txts: ddns.TXT[]) {
        super(id);

        const record = selectSRVFrom(srvs);
        this.endpoint = record.target;
        this.port = record.port;
        this.metadata = txts.reduce((attributes, txt) => {
            return Object.assign(attributes, txt.intoAttributes());
        }, {});

        function selectSRVFrom(srv: ddns.SRV[]): ddns.SRV {
            let minPriority = 65536, options: ddns.SRV[] = [];
            srv.forEach(record => {
                if (minPriority > record.priority) {
                    minPriority = record.priority;
                    options = [record];
                } else if (record.priority === minPriority) {
                    options.push(record);
                }
            });
            let total = options.reduce((sum, option) => sum + option.weight, 0);
            const cutoff = (crypto.randomBytes(1).readUInt8(0) / 255) * total;
            return options.find(option => (total -= option.weight) <= cutoff);
        }
    }

    public toString(): string {
        const attributes: string[] = [
            "endpoint=" + this.endpoint,
            "port=" + this.port,
        ];
        Object.getOwnPropertyNames(this.metadata).forEach(key => {
            const value = this.metadata[key];
            attributes.push(key + (value ? ("=" + value) : ""));
        })
        return super.toString() + " {" + attributes.join(",") + "}";
    }
}
