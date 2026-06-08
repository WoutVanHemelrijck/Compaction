// @author Arwin Gorissen
// @date 2026-02-22

import { describe, it, expect } from 'vitest';
import { SearchEngine } from './search-engine.mjs';
import { BPlusTree } from '../../dbms/indexes/b-plus-tree.mjs';
import { NgramIndex } from './ngram-index.mjs';
import {
  TrivialNodeStorage,
  TrivialLeafNode,
  TrivialInternalNode,
} from '../../dbms/storage/node-storage/trivial-node-storage.mjs';

type DocID = number;

describe('ngramtree', () => {
  it('test', async () => {
    const storage: TrivialNodeStorage<string, Map<DocID, number>> = new TrivialNodeStorage<string, Map<DocID, number>>(
      (a, b) => a.localeCompare(b),
      (key) => key.length,
    );

    const bplustree: BPlusTree<
      string,
      Map<DocID, number>,
      TrivialLeafNode<string, Map<DocID, number>>,
      TrivialInternalNode<string, Map<DocID, number>>
    > = new BPlusTree(storage, 3);

    await bplustree.init();

    const ngramindex: NgramIndex<
      TrivialLeafNode<string, Map<DocID, number>>,
      TrivialInternalNode<string, Map<DocID, number>>
    > = new NgramIndex(bplustree);

    const searchEngine: SearchEngine<
      TrivialLeafNode<string, Map<DocID, number>>,
      TrivialInternalNode<string, Map<DocID, number>>
    > = new SearchEngine<TrivialLeafNode<string, Map<DocID, number>>, TrivialInternalNode<string, Map<DocID, number>>>(
      ngramindex,
    );

    await ngramindex.addDocument(1, 'Test');
    await ngramindex.addDocument(2, 'tesp tesp tesp');
    let res: number = await searchEngine.search('test', 'nl');
    expect(res).toEqual(1);

    await ngramindex.addDocument(1, 'Test test');
    await ngramindex.addDocument(2, 'tesp tesp');
    res = await searchEngine.search('test', 'nl');
    expect(res).toEqual(1);

    await ngramindex.addDocument(
      1,
      'Bouw en rijping. De vlezige zoetzurige vrucht bestaat uit drie lagen, maar soms vormen twee of drie lagen één geheel en zijn ze afzonderlijk niet meer te herkennen. Zo zijn bij de appel het exocarp en mesocarp niet meer van elkaar te onderscheiden en vormen gezamenlijk met de opgezwollen bloembodem het vruchtvlees. Het klokhuis is het endocarp met daarin de zaadjes (pitjes) en in het midden de vaatbundel naar het steeltje. De volgroeide appel kan afgeplat, langwerpig, kegelvormig of scheef zijn en meet 2 tot 13 cm doormeter. Appels vertonen verschillende tinten groen tot geel en rood, met af en toe roodbruine trekken of lenticellen. Het vruchtvlees van de appel heeft geen steencellen, in tegenstelling tot dat van de peer.[1]De appel is een climacterische vrucht; dat wil zeggen dat er een rijpingsfase is met verhoogde productie van etheen en met verhoogde celademhaling onder afgifte van koolstofdioxide. De climacterische fase gaat vaak gepaard met een kleurverandering en met de omzetting van zetmeel in fructose (vruchtensuiker). Tijdens de climacterische fase zijn de stevigheid en de smaak optimaal. Daarna wordt de vrucht gevoelig voor schimmels en sterven er cellen af. Kweek. De kweek van nieuwe fruitbomen wordt bemoeilijkt door de hoge mate van heterozygositeit (gebrek aan raszuiverheid in genetische zin) en de lange tijd die nodig is om een nieuw ras te ontwikkelen. Hierdoor is het aantal commercieel succesvolle rassen relatief beperkt. Meer dan de helft van de wereldproductie bestaat uit de rassen Delicious, Golden Delicious, Granny Smith, Gala en Fuji. Anderzijds, als eenmaal een gewenst fenotype bereikt kan dit gemakkelijk vegetatief worden vermeerderd om grote aantallen identieke fruitbomen te produceren.[2]',
    );
    await ngramindex.addDocument(
      2,
      'Een berg is een landvorm die uit een beperkt gebied bestaat dat duidelijk hoger is dan de omgeving. De flanken van een berg bestaan uit meer of minder steile hellingen en het reliëf op en rondom de berg is groot. Een berg is in het algemeen hoger en steiler dan een heuvel, maar er bestaat geen vaste definitie voor het onderscheid tussen de twee. Soms wordt de definitie aangehouden dat een berg zich meer dan 200 à 300 meter boven zijn omgeving verheft, een kleinere verheffing wordt dan een heuvel genoemd. In de aardrijkskunde en geologie onderscheidt men bergen naar hoogte, ligging of de wijze waarop ze zijn ontstaan. Wanneer vele bergen bij elkaar liggen, spreekt men van een gebergte. Gebergtes kunnen bestaan uit bergketens, aaneengesloten rijen van bergen, of bergmassieven, groepen aan elkaar vast zittende bergen. De duidelijk lagere gebieden tussen de bergen noemt men dalen. Het water, dat in een gebergte in de vorm van regen en sneeuw wordt opgevangen, stroomt door de dalen het gebergte uit. De verbinding tussen de verschillende bergen in een gebergte noemt men bergkammen of graten. Het laagste punt op een bergkam tussen twee bergen is een bergpas. Het hoogste punt van een berg wordt de top genoemd. Een berg kan ook meer toppen hebben, die door graten of kleine zadels met elkaar zijn verbonden. De hoogte van een berg kan op verschillende manieren worden gemeten. De absolute hoogte van een berg is de hoogte ten opzichte van het zeeniveau. Omdat het zeeniveau niet overal gelijk is kunnen voor een berg verschillende absolute hoogtes worden aangegeven, afhankelijk van welk zeeniveau wordt uitgegaan. Bovendien kan de hoogte van bergtoppen die met ijs bedekt zijn variëren naargelang er ijs afsmelt of bij komt.',
    );
    res = await searchEngine.search('Ik zou graag iets weten over fruitteelt.', 'nl');
    expect(res).toEqual(1);
  });
});
